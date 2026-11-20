import { createFileRoute } from "@tanstack/react-router";

import { AgentsSettingsPanel } from "../components/settings/AgentsSettingsPanel";

export const Route = createFileRoute("/_chat/settings/agents")({
  component: AgentsSettingsPanel,
});
