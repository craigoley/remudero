/**
 * Whether a `plan/tasks.d` file name belongs to a task id. Machine-filed shards are named
 * lowercase (`w1-t7090-selector-shadow-miss.yaml`) while hand-filed ones keep the id's case
 * (`W1-T7096-….yaml`), so the id prefix is compared case-insensitively. A case-sensitive
 * match refused W1-T7090's scope amendment as `shard-not-found` on #10369.
 */
export function isTaskShardName(fileName: string, taskId: string): boolean {
  return fileName.toLowerCase().startsWith(`${taskId.toLowerCase()}-`);
}
