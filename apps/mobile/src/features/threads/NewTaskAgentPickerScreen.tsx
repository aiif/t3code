import type { AgentSummary } from "@t3tools/contracts";
import { useNavigation } from "@react-navigation/native";
import * as Haptics from "expo-haptics";
import { T, useGT } from "gt-react-native";
import { ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppBar } from "../../components/ui/AppBar";
import { AppText as Text } from "../../components/ui/AppText";
import { ScreenContent } from "../../components/ui/ScreenContent";
import { SelectionRow } from "../../components/ui/SelectionRow";
import { useAgentList } from "../../state/agents";
import {
  agentDelegationLabel,
  agentSourceLabel,
  groupAgentChoices,
} from "./new-task-agent-options";
import { useNewTaskFlow } from "./new-task-flow-provider";

function AgentRow(props: {
  readonly agent: AgentSummary;
  readonly agents: ReadonlyArray<AgentSummary>;
  readonly selected: boolean;
  readonly isFirst: boolean;
  readonly isLast: boolean;
  readonly onSelect: (agent: AgentSummary) => void;
}) {
  return (
    <SelectionRow
      icon={props.agent.delegationEnabled ? "person.2" : "wrench.and.screwdriver"}
      role="radio"
      isFirst={props.isFirst}
      isLast={props.isLast}
      selected={props.selected}
      title={props.agent.name}
      subtitle={`${agentDelegationLabel(props.agent, props.agents)} · ${agentSourceLabel(props.agent)}`}
      onPress={() => props.onSelect(props.agent)}
    />
  );
}

export function NewTaskAgentPickerRouteScreen() {
  const gt = useGT();
  const flow = useNewTaskFlow();
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const project = flow.selectedProject;
  const list = useAgentList({
    environmentId: project?.environmentId ?? null,
    projectRoot: project?.workspaceRoot ?? null,
  });
  const agents = list.data?.agents ?? [];
  const { teamLeads, specialists } = groupAgentChoices(agents);
  const choose = (agent: AgentSummary | null) => {
    void Haptics.selectionAsync();
    flow.setAgentId(agent?.id ?? null);
    if (agent?.providerInstanceId != null && agent.model != null) {
      flow.setSelectedModelKey(`${agent.providerInstanceId}:${agent.model}`);
    }
    navigation.goBack();
  };

  return (
    <View className="flex-1 bg-sheet" collapsable={false}>
      <AppBar title={gt("Agent")} hideBottomBorder onBack={() => navigation.goBack()} />
      <ScreenContent>
        <ScrollView
          alwaysBounceVertical={false}
          className="flex-1 bg-sheet android:bg-sheet-solid"
          contentContainerStyle={{
            paddingBottom: Math.max(insets.bottom, 16) + 16,
            paddingHorizontal: 16,
            paddingTop: 16,
          }}
          showsVerticalScrollIndicator={false}
        >
          <View className="gap-6">
            <Text textRole="footnote" className="px-1 text-foreground-muted">
              <T>Start with a team lead, a specialist, or a plain thread.</T>
            </Text>

            <View className="gap-2">
              <Text className="px-1 text-2xs font-t3-medium text-foreground-muted uppercase tracking-wide">
                <T>Default</T>
              </Text>
              <View className="overflow-hidden rounded-2xl">
                <SelectionRow
                  icon="circle.dashed"
                  role="radio"
                  isFirst
                  isLast
                  selected={flow.selectedAgentId === null}
                  title={gt("Default")}
                  subtitle={gt("A normal thread. The provider's coding agent handles the task.")}
                  onPress={() => choose(null)}
                />
              </View>
            </View>

            {list.isPending && agents.length === 0 ? (
              <Text className="px-1 text-sm text-foreground-muted">
                <T>Loading agents…</T>
              </Text>
            ) : null}

            {teamLeads.length > 0 ? (
              <View className="gap-2">
                <Text className="px-1 text-2xs font-t3-medium text-foreground-muted uppercase tracking-wide">
                  <T>Team leads</T>
                </Text>
                <Text textRole="footnote" className="px-1 text-foreground-muted">
                  <T>Plans the work and delegates to specialists.</T>
                </Text>
                <View className="overflow-hidden rounded-2xl">
                  {teamLeads.map((agent, index) => (
                    <AgentRow
                      key={agent.id}
                      agent={agent}
                      agents={agents}
                      selected={flow.selectedAgentId === agent.id}
                      isFirst={index === 0}
                      isLast={index === teamLeads.length - 1}
                      onSelect={choose}
                    />
                  ))}
                </View>
              </View>
            ) : null}

            {specialists.length > 0 ? (
              <View className="gap-2">
                <Text className="px-1 text-2xs font-t3-medium text-foreground-muted uppercase tracking-wide">
                  <T>Specialists</T>
                </Text>
                <Text textRole="footnote" className="px-1 text-foreground-muted">
                  <T>Usually spawned by a team lead.</T>
                </Text>
                <View className="overflow-hidden rounded-2xl">
                  {specialists.map((agent, index) => (
                    <AgentRow
                      key={agent.id}
                      agent={agent}
                      agents={agents}
                      selected={flow.selectedAgentId === agent.id}
                      isFirst={index === 0}
                      isLast={index === specialists.length - 1}
                      onSelect={choose}
                    />
                  ))}
                </View>
              </View>
            ) : null}

            {!list.isPending && agents.length === 0 ? (
              <Text className="px-1 text-sm text-foreground-muted">
                <T>No agent definitions are available on this machine.</T>
              </Text>
            ) : null}
            {list.error === null ? null : (
              <Text className="px-1 text-sm text-destructive">{list.error}</Text>
            )}
          </View>
        </ScrollView>
      </ScreenContent>
    </View>
  );
}
