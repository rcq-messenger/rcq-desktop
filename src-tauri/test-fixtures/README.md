# DoH fixtures

Genuine answers from Cloudflare's resolver to queries built by
`src/dns_txt.rs::build_query`, captured 2026-08-05, plus one synthesised
response carrying a signed seed across five character-strings.

They are real rather than hand-written on purpose: a wire format that only
our own encoder agrees with is exactly the bug this channel cannot afford,
since it is tried on the one network where nothing else is left.
