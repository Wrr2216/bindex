import { Router } from "express";
import { asyncHandler, param } from "../lib/http";
import { notFound } from "../lib/errors";
import { getPhoto } from "../services/photos";

export const photosRouter = Router();

photosRouter.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const photo = await getPhoto(param(req, "id"));
    if (!photo) throw notFound("Photo not found");
    res.setHeader("Content-Type", photo.mime);
    res.setHeader("Cache-Control", "private, max-age=86400");
    res.send(photo.bytes);
  }),
);
