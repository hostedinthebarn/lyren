import { UserRoundX } from 'lucide-react';
import type { PersonDTO } from '@shared/types';
import { useLookups } from '../../api/bootstrap';
import { personText } from '../../lib/people';
import { Avatar, Picker, type PickerOption } from '../ui';
import type { DomainPickerProps } from './pickerTypes';
import { PropertyButton } from './PropertyButton';

export interface AssigneePickerProps extends DomainPickerProps {
  value: number | null;
  onChange: (assigneeId: number | null) => void;
  noneLabel?: string;
}

/** Who can be assigned a task (docs/design/task-assignees.md): current members who aren't viewers. */
export function isAssignable(person: Pick<PersonDTO, 'kind' | 'isMember' | 'deleted' | 'role'>): boolean {
  return person.kind === 'account' && person.isMember && !person.deleted && person.role !== 'viewer';
}

/**
 * The picker's options: "Unassigned", then the viewer (if assignable), then the other assignable members by name.
 * A current assignee who can't be assigned any more (left the space, or a viewer now) stays listed, disabled, so
 * the picker still shows who has the task.
 */
export function assigneeOptions(
  people: ReadonlyArray<PersonDTO>,
  o: { viewerId: number; current: number | null; noneLabel: string },
): PickerOption<number | null>[] {
  const byName = (a: PersonDTO, b: PersonDTO) => a.displayName.localeCompare(b.displayName, undefined, { sensitivity: 'base' });
  const assignable = people.filter(isAssignable).sort(byName);
  const me = assignable.find((p) => p.id === o.viewerId);
  const ordered = me ? [me, ...assignable.filter((p) => p !== me)] : assignable;
  const option = (p: PersonDTO, extra: Partial<PickerOption<number | null>> = {}): PickerOption<number | null> => ({
    value: p.id,
    label: p.displayName,
    icon: <Avatar name={p.displayName} size="xs" />,
    ...extra,
  });
  const out: PickerOption<number | null>[] = [
    { value: null, label: o.noneLabel, icon: <UserRoundX className="text-fg-subtle" /> },
    ...ordered.map((p) => option(p, p.id === o.viewerId ? { hint: 'you', keywords: 'me' } : {})),
  ];
  if (o.current !== null && !ordered.some((p) => p.id === o.current)) {
    const person = people.find((p) => p.id === o.current);
    if (person) {
      const peopleById = new Map(people.map((p) => [p.id, p]));
      out.push(option(person, { label: personText(person, peopleById), hint: person.role === 'viewer' ? 'viewer' : undefined, disabled: true }));
    }
  }
  return out;
}

/** Choose a task's assignee. */
export function AssigneePicker({
  value,
  onChange,
  noneLabel = 'Unassigned',
  label = 'Assignee',
  trigger,
  triggerProps,
  panelClassName,
  ...popup
}: AssigneePickerProps) {
  const { people, personById, user } = useLookups();
  const options = assigneeOptions(people, { viewerId: user.id, current: value, noneLabel });
  const current = value !== null ? personById.get(value) : undefined;
  const name = value === null ? noneLabel : current ? personText(current, personById) : 'Unknown user';
  const triggerEl = trigger ?? (
    <PropertyButton
      aria-label={`${label}: ${name}`}
      icon={value === null ? <UserRoundX /> : <Avatar name={current?.displayName ?? '?'} size="xs" />}
      placeholder={value === null}
      {...triggerProps}
    >
      {name}
    </PropertyButton>
  );
  return (
    <Picker<number | null>
      label={label}
      options={options}
      value={value}
      onChange={onChange}
      trigger={triggerEl}
      emptyText="No members"
      className={panelClassName ?? 'w-64'}
      {...popup}
    />
  );
}
