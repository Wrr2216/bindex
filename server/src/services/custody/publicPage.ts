/**
 * The page a party opens from a one-time signing link, on their own phone,
 * without an account. It is served by the server rather than the app bundle
 * because the app shows its sign-in screen to anyone who is not signed in.
 *
 * The HTML is a fixed shell (nothing from the transfer is written into it),
 * and the script renders everything with textContent, so a name or a note
 * cannot inject markup. The site's CSP allows scripts from this origin only,
 * which is why the script is its own file.
 */

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export function signPageHtml(appName: string, accent: string): string {
  const name = escapeHtml(appName);
  const color = /^#[0-9a-fA-F]{6}$/.test(accent) ? accent : "#0284c7";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="referrer" content="no-referrer">
<meta name="robots" content="noindex, nofollow">
<title>Sign · ${name}</title>
<style>
  :root { color-scheme: dark; --accent: ${color}; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 15px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; background: #020617; color: #e2e8f0; }
  main { max-width: 720px; margin: 0 auto; padding: 20px 16px 48px; }
  h1 { font-size: 22px; margin: 4px 0 2px; }
  h2 { font-size: 12px; letter-spacing: .06em; text-transform: uppercase; color: #94a3b8; margin: 22px 0 8px; }
  .kicker { color: #94a3b8; font-size: 12px; letter-spacing: .08em; text-transform: uppercase; }
  .muted { color: #94a3b8; }
  .card { background: #0f172a; border: 1px solid #1e293b; border-radius: 12px; padding: 14px; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  .facts { display: grid; grid-template-columns: max-content 1fr; gap: 4px 12px; font-size: 14px; }
  .facts dt { color: #94a3b8; }
  .facts dd { margin: 0; }
  ul.lines { list-style: none; margin: 0; padding: 0; }
  ul.lines li { border-top: 1px solid #1e293b; padding: 10px 0; display: flex; gap: 10px; flex-wrap: wrap; align-items: flex-start; }
  ul.lines li:first-child { border-top: 0; }
  .line-main { flex: 1 1 220px; min-width: 0; }
  .code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; color: #94a3b8; }
  .photos { display: flex; gap: 6px; margin-top: 6px; }
  .photos img { width: 64px; height: 64px; object-fit: cover; border-radius: 6px; border: 1px solid #334155; }
  .badge { display: inline-block; font-size: 12px; border-radius: 999px; padding: 1px 8px; background: #1e293b; }
  .badge.bad { background: #450a0a; color: #fca5a5; }
  select, input { font: inherit; color: #f1f5f9; background: #1e293b; border: 1px solid #334155; border-radius: 8px; padding: 8px 10px; width: 100%; }
  label { display: block; font-size: 12px; text-transform: uppercase; letter-spacing: .05em; color: #94a3b8; margin-bottom: 4px; }
  .outcome { flex: 0 0 150px; }
  .outcome input { margin-top: 6px; font-size: 13px; }
  .statement { white-space: pre-line; background: #1e293b; border-radius: 8px; padding: 12px; }
  .pad { background: #fff; border-radius: 10px; touch-action: none; width: 100%; height: 190px; display: block; cursor: crosshair; }
  .row { display: flex; gap: 8px; align-items: center; }
  button { font: inherit; border: 0; border-radius: 8px; padding: 10px 16px; cursor: pointer; }
  button.primary { background: var(--accent); color: #fff; font-weight: 600; width: 100%; padding: 13px; font-size: 16px; }
  button.primary:disabled { opacity: .5; cursor: default; }
  button.quiet { background: transparent; color: #cbd5e1; border: 1px solid #334155; }
  .error { background: #450a0a; color: #fecaca; border-radius: 8px; padding: 10px 12px; }
  .done { text-align: center; padding: 40px 12px; }
  .done .tick { font-size: 48px; color: #34d399; }
  @media (max-width: 520px) { .grid { grid-template-columns: 1fr; } }
</style>
</head>
<body>
<main id="app" aria-live="polite"><p class="muted">Loading…</p></main>
<noscript><p style="padding:16px">Signing needs JavaScript. Turn it on and reload this page.</p></noscript>
<script src="/custody-sign/assets/sign.js" defer></script>
</body>
</html>`;
}

export const SIGN_PAGE_SCRIPT = String.raw`(function () {
  "use strict";
  var parts = location.pathname.split("/").filter(Boolean);
  var token = parts[parts.length - 1] || "";
  var api = "/api/custody-public/" + encodeURIComponent(token);
  var app = document.getElementById("app");
  var OUTCOMES = [["accepted", "Received"], ["damaged", "Damaged"], ["missing", "Missing"], ["refused", "Refused"]];

  function h(tag, props) {
    var node = document.createElement(tag);
    if (props) for (var k in props) {
      if (k === "text") node.textContent = props[k];
      else if (k === "class") node.className = props[k];
      else if (k.slice(0, 2) === "on") node.addEventListener(k.slice(2), props[k]);
      else node.setAttribute(k, props[k]);
    }
    for (var i = 2; i < arguments.length; i++) {
      var c = arguments[i];
      if (c === null || c === undefined || c === false) continue;
      node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    }
    return node;
  }
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }
  function fact(list, label, value) {
    if (!value) return;
    list.appendChild(h("dt", { text: label }));
    list.appendChild(h("dd", { text: value }));
  }
  function party(label, p) {
    return h("div", { class: "card" },
      h("div", { class: "kicker", text: label }),
      h("div", { style: "font-weight:600;font-size:16px", text: p.name }),
      p.org ? h("div", { class: "muted", text: p.org }) : null);
  }
  function fail(message) {
    clear(app);
    app.appendChild(h("h1", { text: "This link cannot be used" }));
    app.appendChild(h("p", { class: "muted", text: message }));
  }

  function pad(onChange) {
    var canvas = h("canvas", { class: "pad", "aria-label": "Signature pad" });
    var ctx = canvas.getContext("2d");
    var drawing = false, last = null, inked = false;
    function size() {
      var r = canvas.getBoundingClientRect(), d = window.devicePixelRatio || 1;
      var keep = inked ? canvas.toDataURL() : null;
      canvas.width = Math.round(r.width * d); canvas.height = Math.round(r.height * d);
      ctx.setTransform(d, 0, 0, d, 0, 0);
      ctx.lineWidth = 2.5; ctx.lineCap = "round"; ctx.lineJoin = "round"; ctx.strokeStyle = "#0f172a";
      if (keep) { var img = new Image(); img.onload = function () { ctx.drawImage(img, 0, 0, r.width, r.height); }; img.src = keep; }
    }
    function at(e) { var r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }
    canvas.addEventListener("pointerdown", function (e) {
      e.preventDefault(); drawing = true; last = at(e); canvas.setPointerCapture(e.pointerId);
      ctx.beginPath(); ctx.arc(last.x, last.y, 1.2, 0, Math.PI * 2); ctx.fillStyle = "#0f172a"; ctx.fill();
      if (!inked) { inked = true; onChange(true); }
    });
    canvas.addEventListener("pointermove", function (e) {
      if (!drawing) return; var p = at(e);
      ctx.beginPath(); ctx.moveTo(last.x, last.y); ctx.lineTo(p.x, p.y); ctx.stroke(); last = p;
    });
    function stop() { drawing = false; }
    canvas.addEventListener("pointerup", stop); canvas.addEventListener("pointercancel", stop);
    window.addEventListener("resize", size);
    setTimeout(size, 0);
    return {
      canvas: canvas,
      clear: function () { ctx.clearRect(0, 0, canvas.width, canvas.height); inked = false; onChange(false); },
      png: function () { return inked ? canvas.toDataURL("image/png") : null; }
    };
  }

  function render(d) {
    clear(app);
    var outcomes = {};
    app.appendChild(h("div", { class: "kicker", text: d.appName + " · " + (d.purpose === "delivery" ? "Delivery sign-off" : "Chain of custody") }));
    app.appendChild(h("h1", { text: d.party === "to" ? "Receive and sign" : "Release and sign" }));
    app.appendChild(h("div", { class: "code", text: d.code + " · link expires " + new Date(d.expiresAt).toLocaleString() }));

    app.appendChild(h("h2", { text: "Parties" }));
    app.appendChild(h("div", { class: "grid" }, party("Released by", d.from), party("Received by", d.to)));

    var facts = h("dl", { class: "facts" });
    fact(facts, "Place", d.place);
    fact(facts, "Job", d.jobCode);
    fact(facts, "Shipment", d.shipmentCode);
    fact(facts, "Seals", d.seals.length ? d.seals.join(", ") : "None recorded");
    fact(facts, "Condition", d.conditionNote);
    app.appendChild(h("h2", { text: "Details" }));
    app.appendChild(h("div", { class: "card" }, facts));

    app.appendChild(h("h2", { text: d.editable ? "Check every line (" + d.lines.length + ")" : "Items (" + d.lines.length + ")" }));
    if (d.editable) app.appendChild(h("p", { class: "muted", text: "Mark anything that did not arrive, arrived damaged, or that you refuse. Everything else is recorded as received." }));
    var list = h("ul", { class: "lines" });
    d.lines.forEach(function (l) {
      outcomes[l.id] = { outcome: l.outcome, note: l.note || "" };
      var main = h("div", { class: "line-main" },
        h("div", { style: "font-weight:600", text: l.name }),
        h("div", { class: "code", text: l.code + (l.inside ? " · inside " + l.inside : "") }),
        l.flag ? h("span", { class: "badge bad", text: l.flag }) : null);
      if (l.photos.length) {
        var strip = h("div", { class: "photos" });
        l.photos.forEach(function (p) { strip.appendChild(h("img", { src: p, alt: "", loading: "lazy" })); });
        main.appendChild(strip);
      }
      var side;
      if (d.editable) {
        var select = h("select", { "aria-label": "What you found for " + l.name, onchange: function (e) { outcomes[l.id].outcome = e.target.value; } });
        OUTCOMES.forEach(function (o) {
          var opt = h("option", { value: o[0], text: o[1] });
          if (o[0] === l.outcome) opt.selected = true;
          select.appendChild(opt);
        });
        var note = h("input", { placeholder: "Note (optional)", maxlength: "500", value: l.note || "", "aria-label": "Note for " + l.name,
          oninput: function (e) { outcomes[l.id].note = e.target.value; } });
        side = h("div", { class: "outcome" }, select, note);
      } else {
        side = h("span", { class: "badge" + (l.outcome === "accepted" ? "" : " bad"), text: l.outcomeLabel });
      }
      list.appendChild(h("li", null, main, side));
    });
    app.appendChild(h("div", { class: "card" }, list));

    app.appendChild(h("h2", { text: "Sign" }));
    var name = h("input", { id: "signer-name", autocomplete: "name", maxlength: "200", value: d.signerName || "" });
    var email = h("input", { id: "signer-email", type: "email", autocomplete: "email", maxlength: "320" });
    var button = h("button", { class: "primary", type: "button", text: "Agree and sign", disabled: "disabled" });
    var hasInk = false;
    function ready() { if (hasInk && name.value.trim()) button.removeAttribute("disabled"); else button.setAttribute("disabled", "disabled"); }
    name.addEventListener("input", ready);
    var sig = pad(function (on) { hasInk = on; ready(); });
    var error = h("div");
    app.appendChild(h("div", { class: "card" },
      h("p", { class: "statement", text: d.statement }),
      h("div", { class: "grid" },
        h("div", null, h("label", { for: "signer-name", text: "Your name" }), name),
        h("div", null, h("label", { for: "signer-email", text: "Email (optional)" }), email)),
      h("div", { style: "margin-top:12px" }, sig.canvas),
      h("div", { class: "row", style: "justify-content:space-between;margin:6px 0 14px" },
        h("span", { class: "muted", text: "Sign with your finger or a stylus." }),
        h("button", { class: "quiet", type: "button", text: "Clear", onclick: function () { sig.clear(); } })),
      error,
      button));
    ready();

    button.addEventListener("click", function () {
      var png = sig.png();
      if (!png || !name.value.trim()) return;
      button.setAttribute("disabled", "disabled");
      button.textContent = "Saving…";
      clear(error);
      var body = { signerName: name.value.trim(), signerEmail: email.value.trim() || null, image: png };
      if (d.editable) body.outcomes = d.lines.map(function (l) { return { lineId: l.id, outcome: outcomes[l.id].outcome, note: outcomes[l.id].note.trim() || null }; });
      fetch(api + "/sign", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
        .then(function (res) { return res.json().catch(function () { return {}; }).then(function (b) { return { ok: res.ok, body: b }; }); })
        .then(function (r) {
          if (!r.ok) throw new Error(r.body.error || "The signature could not be saved. Try again.");
          clear(app);
          app.appendChild(h("div", { class: "done" },
            h("div", { class: "tick", text: "✓" }),
            h("h1", { text: "Signed" }),
            h("p", { text: "Thank you. " + d.code + " is recorded" + (r.body.completed ? " and complete." : ". The other party still has to sign.") }),
            h("p", { class: "muted", text: "You can close this page. The link will not work again." })));
        })
        .catch(function (err) {
          error.appendChild(h("p", { class: "error", text: err.message }));
          button.textContent = "Agree and sign";
          ready();
        });
    });
  }

  fetch(api).then(function (res) {
    return res.json().catch(function () { return {}; }).then(function (b) {
      if (!res.ok) return fail(b.error || "This signing link has expired or was already used. Ask for a new one.");
      render(b);
    });
  }).catch(function () { fail("The page could not be loaded. Check your connection and reload."); });
})();
`;
