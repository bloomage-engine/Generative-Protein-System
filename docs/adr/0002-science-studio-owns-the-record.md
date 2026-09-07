# Science Studio owns the research record

Science Studio's record layer is the single source of truth for the research
record (`Project`/`Study`/`Task`/`Run`/`Artifact`/`Evidence`/`Conclusion`). The
agent runtime (a chat-based gateway such as openclaw) is a swappable **executor**,
never the owner of the record. `Run` — one Agent execution, captured per
conversation turn — is the atomic traceable unit.

The gateway exposes a chat transcript (messages / tool-call frames / attachments),
not structured domain entities. If the record lived in the gateway, swapping to a
different runtime would break the record. Owning it independently is what makes
runtimes interchangeable and keeps `Run`/`Artifact`/`Evidence` structured and
reproducible.

- **Status**: accepted
