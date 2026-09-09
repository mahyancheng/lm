import { describe, expect, it } from 'vitest';
import type { ConversationThread } from '@frontier/contracts';
import { companyDialogueHistory } from './TalkPanel';

describe('company CEO dialogue history', () => {
  it('does not hand a new employer turns from the CEO’s former company', () => {
    const thread: ConversationThread = {
      id: 'npc:s:c:p:ceo', sessionId: 's', playerCompanyId: 'p', playerCharacterId: 'founder', targetCharacterId: 'ceo',
      targetCompanyId: 'oldco', nextTurnSequence: 4, lastMessageQuarter: 2,
      turns: [
        { speakerId: 'founder', text: 'Old company private terms', quarter: 1, targetCompanyId: 'oldco' },
        { speakerId: 'ceo', text: 'Old company reply', quarter: 1, targetCompanyId: 'oldco' },
        { speakerId: 'founder', text: 'New company introduction', quarter: 2, targetCompanyId: 'newco' },
        { speakerId: 'ceo', text: 'New company reply', quarter: 2, targetCompanyId: 'newco' },
      ],
    };
    const history = companyDialogueHistory(thread, 'newco', { speakerId: 'founder', text: 'Current new-company question' });
    expect(history.map((turn) => turn.text)).toEqual(['New company introduction', 'New company reply', 'Current new-company question']);
  });
});
