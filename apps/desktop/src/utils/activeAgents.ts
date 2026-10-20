import type { AppData } from '../types';

export function isAvailableAI(data: AppData, id: string | null | undefined): boolean {
  return data.agents.some(a => a.id === id && a.kind === 'ai' && !a.removed);
}

export function livingRoomResponder(data: AppData): string | null {
  if (isAvailableAI(data, data.livingRoomSpeakerId)) return data.livingRoomSpeakerId!;
  if (isAvailableAI(data, 'agent_coordinator')) return 'agent_coordinator';
  return data.agents.find(a => a.kind === 'ai' && !a.removed)?.id ?? null;
}
