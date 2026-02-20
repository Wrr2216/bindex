import { Router } from "express";
import { z } from "zod";
import { env } from "../env";
import { logger } from "../lib/logger";
import { asyncHandler, parse } from "../lib/http";
import { badRequest, forbidden } from "../lib/errors";
import { getOidcClient, generators, subjectId } from "./oidc";
import {
  authenticate,
  countUsers,
  createUser,
  emailAllowed,
  sessionUser,
  upsertFromSso,
} from "../services/users";

export const authRouter = Router();

/**
 * Which sign-in methods the login screen should offer. Also reports whether the
 * instance still has no accounts, which is what puts the client into first-run
 * setup.
 */
authRouter.get(
  "/methods",
  asyncHandler(async (_req, res) => {
    res.json({
      password: env.localLoginEnabled,
      sso: env.oidcConfigured,
      ssoLabel: env.OIDC_BUTTON_LABEL,
      trusted: env.trustedAuth,
      // Only password deployments need a setup screen. Under SSO the first
      // person to sign in becomes the administrator, and under trusted auth
      // there is nobody to create.
      needsSetup: env.localLoginEnabled && (await countUsers()) === 0,
    });
  }),
);

const credentials = z.object({
  email: z.string().min(3).max(320),
  password: z.string().min(1).max(512),
});

authRouter.post(
  "/login",
  asyncHandler(async (req, res) => {
    if (!env.localLoginEnabled) throw forbidden("Password sign-in is turned off.");
    const { email, password } = parse(credentials, req.body);

    const row = await authenticate(email, password);
    if (!row) {
      logger.warn("auth.login.failed", { email: email.toLowerCase() });
      // One message for every failure, so the response cannot be used to tell
      // a wrong password from an address that does not exist.
      res.status(401).json({ error: "Incorrect email or password.", code: "unauthorized" });
      return;
    }

    // A fresh session id on sign-in, so a session fixed before login is useless.
    await new Promise<void>((resolve, reject) =>
      req.session.regenerate((err) => (err ? reject(err) : resolve())),
    );
    req.session.user = sessionUser(row);
    logger.info("auth.login.success", { email: row.email, method: "password" });
    res.json({ user: req.session.user });
  }),
);

const setup = z.object({
  email: z.string().min(3).max(320),
  name: z.string().max(200).default(""),
  password: z.string().min(1).max(512),
});

/**
 * First-run setup: creates the owner account. Only reachable while the instance
 * has no accounts at all, which closes the window as soon as it is used.
 */
authRouter.post(
  "/setup",
  asyncHandler(async (req, res) => {
    if (!env.localLoginEnabled) throw forbidden("Password sign-in is turned off.");
    if ((await countUsers()) > 0) throw forbidden("This instance is already set up.");
    const input = parse(setup, req.body);
    if (!emailAllowed(input.email)) {
      throw badRequest("That address is not in ALLOWED_EMAILS.");
    }

    const created = await createUser({ ...input, role: "admin" });
    await new Promise<void>((resolve, reject) =>
      req.session.regenerate((err) => (err ? reject(err) : resolve())),
    );
    req.session.user = {
      oid: created.oid,
      email: created.email,
      name: created.name,
      role: created.role,
    };
    logger.info("auth.setup.completed", { email: created.email });
    res.status(201).json({ user: req.session.user });
  }),
);

authRouter.get(
  "/sso",
  asyncHandler(async (req, res) => {
    const client = await getOidcClient();
    if (!client) {
      res.status(503).send("Single sign-on is not configured on this instance.");
      return;
    }

    const codeVerifier = generators.codeVerifier();
    const state = generators.state();
    const nonce = generators.nonce();
    // Only same-origin paths, so the redirect cannot be pointed off-site.
    const requested = typeof req.query.returnTo === "string" ? req.query.returnTo : "/";
    const returnTo = requested.startsWith("/") && !requested.startsWith("//") ? requested : "/";
    req.session.oauth = { state, nonce, codeVerifier, returnTo };

    res.redirect(
      client.authorizationUrl({
        scope: env.oidcScopes,
        state,
        nonce,
        code_challenge: generators.codeChallenge(codeVerifier),
        code_challenge_method: "S256",
      }),
    );
  }),
);

authRouter.get(
  "/callback",
  asyncHandler(async (req, res) => {
    const client = await getOidcClient();
    if (!client) return res.redirect("/");

    const oauth = req.session.oauth;
    if (!oauth) {
      res.status(400).send("Missing sign-in state. Start again from the sign-in page.");
      return;
    }
    delete req.session.oauth;

    const tokenSet = await client.callback(env.oidcRedirectUri, client.callbackParams(req), {
      state: oauth.state,
      nonce: oauth.nonce,
      code_verifier: oauth.codeVerifier,
    });

    const claims = tokenSet.claims() as Record<string, unknown>;
    const email = String(claims.email ?? claims.preferred_username ?? "").toLowerCase();
    if (!emailAllowed(email)) {
      logger.warn("auth.login.denied", { email });
      req.session.destroy(() => undefined);
      res.status(403).send("This account is not permitted to use this instance.");
      return;
    }

    const row = await upsertFromSso({
      subject: subjectId(String(claims.sub)),
      email,
      name: String(claims.name ?? email ?? "User"),
    });

    const user = sessionUser(row);
    const returnTo = oauth.returnTo || "/";
    await new Promise<void>((resolve, reject) =>
      req.session.regenerate((err) => (err ? reject(err) : resolve())),
    );
    req.session.user = user;
    logger.info("auth.login.success", { email: user.email, method: "sso" });
    res.redirect(returnTo);
  }),
);

authRouter.post("/logout", (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

authRouter.get("/logout", (req, res) => {
  req.session.destroy(() => res.redirect("/"));
});
