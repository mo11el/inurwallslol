import cron from 'node-cron';

interface ScheduledTask {
  id: string;
  expression: string; // Standard Cron Expression
  action: () => Promise<void> | void;
  description: string;
  timezone?: string;
}

class AssistantScheduler {
  private activeTasks: Map<string, cron.ScheduledTask>;

  constructor() {
    this.activeTasks = new Map();
  }

  /**
   * Schedules a new task for the AI Assistant
   * @param task - The task details and cron timing
   */
  public scheduleTask(task: ScheduledTask): void {
    if (this.activeTasks.has(task.id)) {
      console.warn(`[Scheduler] Task ${task.id} is already running. Stopping previous instance.`);
      this.stopTask(task.id);
    }

    const options: cron.ScheduleOptions = {};
    if (task.timezone) {
      options.timezone = task.timezone;
    }

    const job = cron.schedule(task.expression, async () => {
      console.log(`[Scheduler] Executing: ${task.description}`);
      try {
        await task.action();
      } catch (err) {
        console.error(`[Scheduler] Error executing task ${task.id}:`, err);
      }
      
      // Stop and remove one-off tasks after execution
      this.stopTask(task.id);
    }, options);

    this.activeTasks.set(task.id, job);
    console.log(`[Scheduler] Task ${task.id} scheduled: ${task.expression} (TZ: ${task.timezone || 'Local'})`);
  }

  /**
   * Stops a specific task by ID
   */
  public stopTask(id: string): void {
    const job = this.activeTasks.get(id);
    if (job) {
      job.stop();
      this.activeTasks.delete(id);
      console.log(`[Scheduler] Task ${id} has been terminated.`);
    }
  }

  /**
   * Helper for one-off reminders (converts datetime string to cron)
   */
  public scheduleReminder(dateStr: string, timezone: string, description: string, action: () => Promise<void> | void): void {
    // dateStr is expected to be ISO-like without offset, e.g., "2026-05-15T09:00:00"
    // Extracting components strictly from the string avoids JS Date timezone shifts.
    let year, month, day, hour, minute;
    
    try {
      // Basic extraction handling "YYYY-MM-DDTHH:mm:ss"
      const [datePart, timePart] = dateStr.split('T');
      const dateParts = datePart.split('-');
      const timeParts = timePart.split(':');
      
      year = parseInt(dateParts[0], 10);
      month = parseInt(dateParts[1], 10);
      day = parseInt(dateParts[2], 10);
      hour = parseInt(timeParts[0], 10);
      minute = parseInt(timeParts[1], 10);
    } catch (err) {
      console.error(`[Scheduler] Failed to parse datetime: ${dateStr}. Cannot schedule reminder.`);
      return;
    }

    const cronExpr = `${minute} ${hour} ${day} ${month} *`;
    
    this.scheduleTask({
      id: `reminder_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
      expression: cronExpr,
      timezone: timezone,
      description: description,
      action: action
    });
  }
}

export default new AssistantScheduler();
