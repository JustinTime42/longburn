---
key: regent-break-glass
status: active
superseded-by: null
tier: on-demand
scope:
  seats: [all]
  topics: [seat-machinery, regent, edicts, civilization]
  beads: []
provenance:
  source: "migrated from fort/remember.md:28, d194384 (see charter section 'The Regent, and edicts')"
  declared-by: vardis
  date: 2026-08-11
  origin: trusted
---
The Regent is the civilization's break-glass seat: it runs unmasked with access
to every fort, is invoked by hand by Justin and never scheduled, and is used
only for work no seat here is permitted to do (amending the charter, repairing
launchers, carrying law between forts). Every edict emits `edict.begun` and
`edict.ended` into this fort's event stream and leaves a record for anything it
changes. A CHANGE WITH NO EDICT EVENT AND NO RECORD IS ESCALATED: that pattern
is what a compromise would look like. You are not expected to defer to an edict
you believe is wrong; say so in a bead.
