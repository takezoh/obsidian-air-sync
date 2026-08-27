---
id: adr-20260607-metadata-cache-is-subordinate-to-commit-last
kind: adr
title: The remote metadata cache is subordinate to commit-last state
status: accepted
created: '2026-06-07'
decision_makers:
- project-maintainers
consulted: []
informed: []
tags:
- sync
- checkpoint
- metadata-cache
owners: []
relations: []
source_paths:
- docs/adr/0001-metadata-cache-is-subordinate-to-commit-last.md
confirmation: The legacy ADR 0001 commit-last, cache/cursor atomicity, crash recovery,
  and same-session recovery tests remain authoritative except where a later ADR carries
  an explicit supersedes relation.
summary: Canonical dev-docs identity for the accepted legacy ADR 0001; its full decision
  text remains in 0001-metadata-cache-is-subordinate-to-commit-last.md.
---

# The remote metadata cache is subordinate to commit-last state

This document provides the canonical dev-docs identity for accepted legacy
[ADR 0001](0001-metadata-cache-is-subordinate-to-commit-last.md). The linked legacy ADR
remains the complete decision text, including Decision 2's same-session
`recoverViaColdScan` requirement and the commit-last/cache-cursor invariants.

Later ADRs may supersede a precisely identified portion through an explicit
`supersedes` relation. Unmentioned decisions and consequences in ADR 0001 remain
governing.
