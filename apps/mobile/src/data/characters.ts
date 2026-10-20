import type {Character,OfficialMemberConfig,MemberDto} from '../types';
export const OFFICIAL_MEMBERS:OfficialMemberConfig[]=[];
export const CHARACTERS:Character[]=[];
export function memberCharacter(m:MemberDto):Character {
 return {id:m.agentId,name:m.displayName,pinyin:m.displayName,title:m.displayName,role:m.kind==='human'?'使用者':'AI',
 frenchRole:m.kind==='human'?'Owner':'Agent',avatarSeed:m.agentId,avatarUrl:m.avatarDataUrl,kind:m.kind,executorId:null,
 available:m.available,statusNote:m.status||'',signatureColor:'#666',bubbleBg:'#f5f5f5',bubbleBorder:'#ddd',textColor:'#222',greeting:''};
}
export function updateCharacters(members:MemberDto[]){CHARACTERS.splice(0,CHARACTERS.length,...members.map(memberCharacter));window.dispatchEvent(new Event('luma_members_updated'));}
