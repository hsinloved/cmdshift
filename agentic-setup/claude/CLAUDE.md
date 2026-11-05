<!-- agentic-setup:executor -->
## Tools: Executor

All external services go through the `executor` MCP server. It is the only path:
don't use other plugins, connectors or CLIs for these services.

Connected services (edit to match your Executor):
- Chat: Slack
- Email and calendar: Gmail, Google Calendar
- Issues and docs: Linear, Notion
- DNS and hosting: Cloudflare, Render
- Errors: Sentry
- Search: web search, library docs, code search
- Agents: T3 Code (threads on every linked machine)

Rules:
- Messages, email and calendar always go through Executor.
- The account follows the folder. Work repos see work accounts, everything
  else sees personal ones. Never try to reach the other identity.
- Write actions (sending, posting, launching or stopping threads) may wait for
  approval in Executor. Say what you're waiting on instead of retrying.
- Before continuing work another thread started, read that thread's history
  through T3 in Executor.
<!-- /agentic-setup:executor -->
