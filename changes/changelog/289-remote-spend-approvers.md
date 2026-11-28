section: Changes
- **Who may approve spend remotely is settled (#289).** With remote answers on, a collaborator with write, maintain or admin permission may approve or refuse a spend request with `/orbit answer`, like any other question; anyone with less permission and any bot is refused. `docs/operations.md`, "Spend requests", says so, and a unit test holds the rule.
