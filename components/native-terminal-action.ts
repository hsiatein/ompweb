import { translate } from "@/lib/i18n";
import { copyText } from "@/lib/clipboard";
import { getTerminalCommandMode, getTerminalSshHost, terminalCommand } from "@/lib/native-terminal-prefs";
import { toast } from "./ui/toast";

/** "Copy terminal command": a command that opens a shell in `dir` (`cd`, or ssh from another computer). */
export function copyTerminalCommandAt(dir: string): void {
  const command = terminalCommand(getTerminalCommandMode(), window.location.hostname, getTerminalSshHost(), dir);
  copyText(command).then(
    () => toast.success(translate("terminalCommand.copied"), command),
    () => toast.error(translate("contextMenu.copyFailed")),
  );
}
