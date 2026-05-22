import type { Message } from "@earendil-works/pi-ai";
import type { ForkResult } from "./types.js";

export function processPiEvent(event: unknown, result: ForkResult): boolean;
export function processPiJsonLine(line: string, result: ForkResult): boolean;
export function getFinalAssistantText(messages: Message[]): string;
export function getForkProgressText(result: Partial<ForkResult> | undefined): string;
export function getResultSummaryText(result: Partial<ForkResult> | undefined): string;
