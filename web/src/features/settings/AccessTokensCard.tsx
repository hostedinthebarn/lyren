// Account settings → Security: personal access tokens for the API and MCP (design §5.12). Creating one
// needs the re-auth window; the token itself is shown once, in the dialog that created it.

import { KeyRound } from 'lucide-react';
import { useMemo, useState, type FormEvent } from 'react';
import { TOKEN_ROLES, type TokenRole } from '@shared/roles';
import { tokenCreateInput } from '@shared/schemas';
import type { TokenDTO } from '@shared/types';
import { useAccessTokens, useCreateAccessToken, useRevokeAccessToken } from '../../api/account';
import { useAuthStatus } from '../../api/auth';
import {
  Badge,
  Button,
  CopyField,
  Dialog,
  ErrorState,
  Field,
  Input,
  Select,
  SkeletonList,
  apiFieldErrors,
  hasFieldErrors,
  toast,
  useConfirm,
  zodFieldErrors,
  type FieldErrors,
} from '../../components/ui';
import { ensureReauth } from '../account/ReauthDialog';
import { TOKEN_EXPIRY_OPTIONS, TOKEN_ROLE_LABELS, tokenDetails, tokenExpired, tokenScopeText } from './accessTokens';
import { SettingsCard } from './SettingsBlocks';

const EVERY_SPACE = '';

function CreateTokenDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const spaces = useAuthStatus().data?.spaces ?? [];
  const create = useCreateAccessToken();
  const [name, setName] = useState('');
  const [spaceId, setSpaceId] = useState(EVERY_SPACE);
  const [role, setRole] = useState<TokenRole>('member');
  const [expiry, setExpiry] = useState('90');
  const [errors, setErrors] = useState<FieldErrors>({});
  const [created, setCreated] = useState<string | null>(null);

  const close = () => {
    setName('');
    setSpaceId(EVERY_SPACE);
    setRole('member');
    setExpiry('90');
    setErrors({});
    setCreated(null);
    create.reset();
    onClose();
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const parsed = tokenCreateInput.safeParse({
      name,
      spaceId: spaceId === EVERY_SPACE ? null : spaceId,
      role,
      expiresInDays: TOKEN_EXPIRY_OPTIONS.find((o) => o.value === expiry)?.days ?? null,
    });
    if (!parsed.success) {
      setErrors(zodFieldErrors(parsed.error));
      return;
    }
    setErrors({});
    if (!(await ensureReauth())) return;
    try {
      setCreated((await create.mutateAsync(parsed.data)).token);
    } catch (err) {
      const fields = apiFieldErrors(err);
      if (hasFieldErrors(fields)) setErrors(fields);
      else toast.error(err);
    }
  };

  if (created !== null) {
    return (
      <Dialog
        open={open}
        onClose={close}
        title="Your new access token"
        description="Copy it now: it is not shown again. Anyone who has it can use it as you, up to its role."
        closeOnOutsideClick={false}
        footer={<Button onClick={close}>Done</Button>}
      >
        <CopyField value={created} label="access token" />
      </Dialog>
    );
  }

  return (
    <Dialog
      open={open}
      onClose={close}
      title="New access token"
      description="For scripts and AI assistants (MCP) that work in your spaces through the API."
      onSubmit={(e) => void submit(e)}
      closeOnOutsideClick={false}
      footer={
        <>
          <Button variant="ghost" onClick={close}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" loading={create.isPending}>
            Create token
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label="Name" hint="What uses it, to recognise it later." error={errors.name} required>
          <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} autoComplete="off" />
        </Field>
        <Field label="Spaces" error={errors.spaceId}>
          <Select
            value={spaceId}
            onChange={(e) => setSpaceId(e.target.value)}
            options={[{ value: EVERY_SPACE, label: 'Every space I belong to' }, ...spaces.map((s) => ({ value: s.id, label: s.name }))]}
          />
        </Field>
        <Field label="Role" hint="It never does more than you can: an admin token acts as a member where you are a member." error={errors.role}>
          <Select
            value={role}
            onChange={(e) => setRole(e.target.value as TokenRole)}
            options={TOKEN_ROLES.map((r) => ({ value: r, label: TOKEN_ROLE_LABELS[r] }))}
          />
        </Field>
        <Field label="Expires" error={errors.expiresInDays}>
          <Select value={expiry} onChange={(e) => setExpiry(e.target.value)} options={TOKEN_EXPIRY_OPTIONS.map((o) => ({ value: o.value, label: o.label }))} />
        </Field>
      </div>
    </Dialog>
  );
}

function TokenRow({ token, spaceNames, onRevoke, revoking }: { token: TokenDTO; spaceNames: ReadonlyMap<string, string>; onRevoke: () => void; revoking: boolean }) {
  const nowMs = Date.now();
  return (
    <li className="flex min-w-0 items-center gap-3 px-4 py-3">
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <span className="truncate text-sm font-medium text-fg">{token.name}</span>
          <Badge variant="outline">{TOKEN_ROLE_LABELS[token.role]}</Badge>
          <span className="text-[13px] text-fg-muted">{tokenScopeText(token, spaceNames)}</span>
          {tokenExpired(token, nowMs) && <Badge variant="warning">Expired</Badge>}
        </div>
        <p className="mt-0.5 text-[13px] text-fg-muted">{tokenDetails(token, nowMs)}</p>
      </div>
      <Button size="sm" onClick={onRevoke} loading={revoking} aria-label={`Revoke the access token “${token.name}”`}>
        Revoke
      </Button>
    </li>
  );
}

export function AccessTokensCard() {
  const tokens = useAccessTokens();
  const revoke = useRevokeAccessToken();
  const confirm = useConfirm();
  const spaces = useAuthStatus().data?.spaces;
  const spaceNames = useMemo(() => new Map((spaces ?? []).map((s) => [s.id, s.name])), [spaces]);
  const [creating, setCreating] = useState(false);

  const revokeToken = async (token: TokenDTO) => {
    const ok = await confirm({
      title: `Revoke the access token “${token.name}”?`,
      body: 'Whatever uses it stops working at once.',
      confirmLabel: 'Revoke',
      danger: true,
    });
    if (!ok) return;
    revoke.mutate(token.id, {
      onSuccess: () => toast.success(`Revoked the access token “${token.name}”`),
      onError: (err) => toast.error(err),
    });
  };

  return (
    <SettingsCard
      title="Access tokens"
      description="Let scripts and AI assistants work in your spaces through the API and MCP, without your password. They cannot change your account."
      flush
      actions={
        <Button size="sm" icon={<KeyRound aria-hidden />} onClick={() => setCreating(true)} disabled={!tokens.data}>
          New token
        </Button>
      }
    >
      {tokens.isPending ? (
        <SkeletonList rows={1} className="px-4 pb-3" />
      ) : tokens.error ? (
        <ErrorState size="sm" error={tokens.error} onRetry={() => void tokens.refetch()} />
      ) : tokens.data.length === 0 ? (
        <p className="border-t border-border px-4 py-3 text-sm text-fg-muted">No access tokens.</p>
      ) : (
        <ul className="divide-y divide-border border-t border-border" aria-label="Access tokens">
          {tokens.data.map((t) => (
            <TokenRow
              key={t.id}
              token={t}
              spaceNames={spaceNames}
              revoking={revoke.isPending && revoke.variables === t.id}
              onRevoke={() => void revokeToken(t)}
            />
          ))}
        </ul>
      )}
      <CreateTokenDialog open={creating} onClose={() => setCreating(false)} />
    </SettingsCard>
  );
}
