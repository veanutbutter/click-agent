import type { Tool } from "./types.js";
import {
  editFileTool,
  listDirTool,
  readFileTool,
  searchTool,
  writeFileTool,
} from "./fileTools.js";
import { runCommandTool } from "./shellTool.js";

export type { Tool, ToolContext, ToolResult, ProposedFileChange } from "./types.js";
export { readFileTool, writeFileTool, editFileTool, listDirTool, searchTool } from "./fileTools.js";
export { runCommandTool } from "./shellTool.js";

/** All tools Click ships with. */
export function builtInTools(): Tool[] {
  return [
    readFileTool,
    writeFileTool,
    editFileTool,
    listDirTool,
    searchTool,
    runCommandTool,
  ];
}

/** Filter the catalogue down to a configured allow-list. */
export function selectTools(names: string[] | undefined): Tool[] {
  const all = builtInTools();
  if (!names || names.length === 0) return all;
  const allowed = new Set(names);
  return all.filter((tool) => allowed.has(tool.name));
}
