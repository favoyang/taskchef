import { Alert, Badge, Button, Group, Paper, Select, Stack, Text, Title } from '@mantine/core';
import { useEffect, useState } from 'react';

type Role = { role: string; source: string | null; effectiveSource: string | null; model: unknown; effort: unknown; status: string; availability: string; fallback: string; problems: string[] };
type Profile = { id: string; project: string; roles: Role[]; problems: string[]; precedence?: string; scope?: string; catalogSource: string | null };

function setting(value: unknown, name: string) {
  return typeof value === 'string' ? value : value == null ? `${name} omitted` : `Invalid ${name.toLowerCase()} value`;
}

export function ModelSettings() {
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [selection, setSelection] = useState('personal');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    fetch('/api/settings', { signal: controller.signal }).then(async (response) => {
      if (!response.ok) throw new Error('Settings preview could not be loaded.');
      const data = await response.json() as { profiles: Profile[] };
      setProfiles(data.profiles);
    }).catch((failure: Error) => {
      if (!controller.signal.aborted) setError(failure.message);
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [revision]);
  const profile = profiles.find((item) => item.id === selection) ?? profiles[0];
  return <Stack gap="md" aria-label="Model settings">
    <Group justify="space-between">
      <Title order={2} size="h3">Model roles</Title>
      <Button variant="light" loading={loading} onClick={() => setRevision((value) => value + 1)}>Refresh</Button>
    </Group>
    <Text c="dimmed" size="sm">Preview user-owned Codex agent preferences for planning, implementation, and independent review.</Text>
    {error && <Alert color="red" role="alert">{error}</Alert>}
    {loading && <Text role="status">Loading model preferences…</Text>}
    {profile && <>
      <Select label="Profile scope" data={profiles.map((item) => ({ value: item.id, label: item.project }))} value={profile.id} onChange={(value) => setSelection(value ?? 'personal')} />
      {profile.problems.map((problem) => <Alert color="yellow" key={problem}>{problem}</Alert>)}
      {profile.roles.map((role) => <Paper key={role.role} withBorder p="md">
        <Stack gap="xs">
          <Group justify="space-between"><Title order={3} size="h4" tt="capitalize">{role.role}</Title><Badge color={['invalid', 'unavailable'].includes(role.status) ? 'red' : role.status === 'missing' ? 'gray' : 'teal'}>{role.status}</Badge></Group>
          <Text fw={600}>{setting(role.model, 'Model')} · {setting(role.effort, 'Effort')}</Text>
          <Text size="sm" style={{ overflowWrap: 'anywhere' }}>Source: {role.source ?? 'No role file'}</Text>
          <Text size="sm">{role.status === 'configured' ? 'Requested effective settings; passed as explicit overrides after native-tool validation.' : role.status === 'missing' ? `Effective fallback: ${role.fallback}.` : 'Overrides blocked until the configuration problem is resolved or a valid explicit user choice is supplied.'}</Text>
          <Text c="dimmed" size="sm">When missing: {role.fallback}.</Text>
          {typeof role.model === 'string' && <Text c="dimmed" size="sm">Availability: {role.availability}.</Text>}
          {role.problems.map((problem) => <Alert key={problem} color="red">{problem}</Alert>)}
        </Stack>
      </Paper>)}
      <Paper withBorder p="md"><Stack gap="xs">
        <Text fw={600}>Precedence and validation</Text>
        <Text size="sm">{profile.precedence}</Text>
        <Text size="sm">{profile.scope}</Text>
        <Text c="dimmed" size="sm" style={{ overflowWrap: 'anywhere' }}>Catalog: {profile.catalogSource ?? 'Unavailable'}. This preview does not prove that a future run will honor the profile. The current native interface validates model availability.</Text>
      </Stack></Paper>
    </>}
  </Stack>;
}
