import type { Member } from './store/types.js';

export function describeMember(member: Member): string {
  return `${member.name}（ID ${member.id}${member.aliases.length ? `；别名：${member.aliases.join('、')}` : ''}）`;
}

export function validateMemberId(id: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error('成员 ID 只能包含字母、数字、下划线和短横线。');
  return id;
}
export function resolveMember(value: string, members: Member[]): Member | undefined {
  const needle = value.trim().toLocaleLowerCase('en-US');
  const found = members.filter(member => [member.id, member.name, ...member.aliases]
    .some(alias => alias.toLocaleLowerCase('en-US') === needle));
  return found.length === 1 ? found[0] : undefined;
}
