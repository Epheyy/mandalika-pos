-- A08 (owner decision at release, separate from 0062): every receive PIN hash has sat on
-- tablets in debuggable storage, and a 4-digit PIN falls quickly offline. Clear them all so
-- admins set new ones. NOT reversible; old servers accept re-set PINs. Drop this file from
-- the release if the owner declines the wipe.
UPDATE users SET receive_pin_hash = NULL, receive_pin_set_at = NULL
 WHERE receive_pin_hash IS NOT NULL OR receive_pin_set_at IS NOT NULL;
