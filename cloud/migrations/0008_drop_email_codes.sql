-- Sign-in codes by email are gone (Google sign-in since 0.5.6; docs/adr/0004). Their table goes with them.
DROP TABLE IF EXISTS email_codes;
