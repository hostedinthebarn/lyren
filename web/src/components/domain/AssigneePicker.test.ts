import { describe, expect, it } from 'vitest';
import type { PersonDTO } from '@shared/types';
import { assigneeOptions, isAssignable } from './AssigneePicker';

const person = (id: number, displayName: string, o: Partial<PersonDTO> = {}): PersonDTO => ({
  id,
  displayName,
  kind: 'account',
  isMember: true,
  deleted: false,
  role: 'member',
  ...o,
});

const people = [
  person(1, 'Zoe', { role: 'owner' }),
  person(2, 'ann', { role: 'admin' }),
  person(3, 'Bob'),
  person(4, 'Vic', { role: 'viewer' }),
  person(5, 'Lee', { isMember: false, role: null }),
  person(-1, 'Old', { kind: 'placeholder', isMember: false, role: null }),
  person(6, 'Gone', { isMember: false, deleted: true, role: null }),
];

describe('isAssignable', () => {
  it('takes members, admins and owners, and nobody else', () => {
    expect(people.filter(isAssignable).map((p) => p.id)).toEqual([1, 2, 3]);
    expect(isAssignable(person(9, 'New', { role: null }))).toBe(true); // a role not synced yet
  });
});

describe('assigneeOptions', () => {
  it('lists Unassigned, then the viewer, then the others by name', () => {
    const options = assigneeOptions(people, { viewerId: 3, current: null, noneLabel: 'Unassigned' });
    expect(options.map((o) => [o.value, o.label, o.hint ?? null])).toEqual([
      [null, 'Unassigned', null],
      [3, 'Bob', 'you'],
      [2, 'ann', null],
      [1, 'Zoe', null],
    ]);
  });

  it('keeps a current assignee who can no longer be assigned, disabled, so the picker still shows them', () => {
    const left = assigneeOptions(people, { viewerId: 1, current: 5, noneLabel: 'Unassigned' }).at(-1)!;
    expect(left).toMatchObject({ value: 5, label: 'Lee (former member)', disabled: true });
    const viewer = assigneeOptions(people, { viewerId: 1, current: 4, noneLabel: 'Unassigned' }).at(-1)!;
    expect(viewer).toMatchObject({ value: 4, label: 'Vic', hint: 'viewer', disabled: true });
  });
});
