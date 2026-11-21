import { AppBar } from "../../components/ui/AppBar";
import type { AppBarAction } from "../../components/ui/AppBar.types";
import { useAdaptiveWorkspaceLayout } from "../layout/AdaptiveWorkspaceLayout";
import { useWorkspaceBackNavigation } from "../layout/workspace/useAndroidWorkspaceNavigation";
import { threadTerminalMenu, type ThreadGitControlsProps } from "./ThreadGitControls";

export function ThreadHeader(props: {
  readonly title: string;
  readonly subtitle: string;
  readonly gitControls: ThreadGitControlsProps;
  readonly onReturnToThread?: () => void;
  readonly draft?: boolean;
  /** Opens the details sheet that carries the context, usage, git and files controls. */
  readonly onOpenDetails: () => void;
}) {
  const goBack = useWorkspaceBackNavigation();
  const { startNewTask } = useAdaptiveWorkspaceLayout();
  const terminalMenu = threadTerminalMenu(props.gitControls);
  const actions: AppBarAction[] = [
    {
      accessibilityLabel: "Thread details",
      icon: "sidebar.right",
      separateBackground: false,
      onPress: props.onOpenDetails,
    },
  ];

  return (
    <AppBar
      title={props.title}
      subtitle={props.subtitle}
      onBackToList={goBack}
      onCompose={props.draft ? undefined : startNewTask}
      backInSplitView={
        props.onReturnToThread
          ? {
              accessibilityLabel: "Return to chat",
              icon: "chevron.left",
              onPress: props.onReturnToThread,
            }
          : undefined
      }
      actions={actions}
      menus={[terminalMenu].filter(
        (menu): menu is NonNullable<typeof terminalMenu> => menu !== null,
      )}
      hideBottomBorder
    />
  );
}
