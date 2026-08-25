-- Deleting a message and deleting a conversation. Additive only: nothing
-- here drops, renames, or rewrites an existing column, and every statement
-- is idempotent, so this runs on every deploy alongside schema.sql the
-- same way schema.sql itself does.
--
-- Two different meanings of "delete", one column each:
--
--   messages.deleted_at            a tombstone. The row stays, its body is
--                                  emptied, and both participants see that
--                                  a message was deleted rather than the
--                                  thread silently changing shape. Only the
--                                  message's own sender can set it.
--
--   conversation_participants      per-participant. Clearing a conversation
--     .cleared_at                  hides it, and every message in it up to
--                                  that instant, from that one participant.
--                                  The other side keeps their copy, which
--                                  is why this is a column here rather than
--                                  anything on `conversations`.

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

ALTER TABLE conversation_participants
  ADD COLUMN IF NOT EXISTS cleared_at TIMESTAMPTZ;
