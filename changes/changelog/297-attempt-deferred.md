section: Fixes
- **A deferred attempt says why (#297).** An implementation attempt deferred for capacity now records one `attempt.deferred` event naming the reason and the workers holding the slots, shown by `orbit timeline` and as `orbit status`'s last event, instead of leaving the run looking hung.
