-- ============================================================
-- 049_broadcast_header_media.sql — remember a campaign's header media
-- ============================================================
-- The image/video/document a media-header template is sent with was
-- only held by the wizard tab. A server-side resume or "retry failed"
-- (038) then had nothing to send and every recipient failed with
-- "Image header requires a media link". Store it on the broadcast.

ALTER TABLE broadcasts
  ADD COLUMN IF NOT EXISTS header_media_url text;
