import { NextResponse } from "next/server";
import { parseJsonWithinLimit } from "@/lib/bounded-form-data";
import { allowFileRoot } from "@/lib/file-access";
import { createScheduledTask, listScheduledTasks, type ScheduledTaskInput } from "@/lib/scheduled-tasks";
import { listNetworkInterfaces } from "@/lib/webhook-listeners";
import { MAX_TASK_REQUEST_BYTES, taskErrorResponse } from "@/lib/scheduled-task-responses";

export const dynamic = "force-dynamic";

// GET /api/scheduled-tasks — every standalone scheduled task with its recent runs,
// the server's time zone (wall-clock schedules run in it) and its network
// interfaces (a webhook can listen on chosen ones).
export async function GET() {
  try {
    return NextResponse.json({
      tasks: listScheduledTasks(),
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      interfaces: listNetworkInterfaces(),
    });
  } catch (error) {
    return taskErrorResponse(error);
  }
}

// POST body: ScheduledTaskInput — create a task.
export async function POST(req: Request) {
  try {
    const body = await parseJsonWithinLimit<ScheduledTaskInput | null>(req, MAX_TASK_REQUEST_BYTES);
    const task = await createScheduledTask(body ?? {});
    // Runs create sessions there; make it browsable like a new chat's cwd.
    if (!task.targetSessionId) allowFileRoot(task.cwd);
    return NextResponse.json({ task });
  } catch (error) {
    return taskErrorResponse(error);
  }
}
