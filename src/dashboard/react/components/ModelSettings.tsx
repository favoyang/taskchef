import { Alert, Badge, Button, Group, Paper, Stack, Text, Title } from '@mantine/core';
import { useEffect, useState } from 'react';

type Role = { role: string; source: string | null; model: unknown; effort: unknown; status: string; problems: string[] };
type Profile = { id: string; roles: Role[]; problems: string[] };

function setting(value: unknown, name: string) {
  return typeof value === 'string' ? value : value == null ? 'Default' : `Invalid ${name.toLowerCase()} value`;
}

export function ModelSettings() {
  const [profiles, setProfiles] = useState<Profile[]>([]);
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
  const profile = profiles.find((item) => item.id === 'personal');
  return <Stack gap="md" aria-label="Model settings">
    <Group justify="space-between">
      <Title order={2} size="h3">Model roles</Title>
      <Button variant="light" loading={loading} onClick={() => setRevision((value) => value + 1)}>Refresh</Button>
    </Group>
    <Text c="dimmed" size="sm">Your models for planning, implementation, and review.</Text>
    {error && <Alert color="red" role="alert">{error}</Alert>}
    {loading && <Text role="status">Loading model preferences…</Text>}
    {profile && <>
      {profile.problems.map((problem) => <Alert color="yellow" key={problem}>{problem}</Alert>)}
      {profile.roles.map((role) => <Paper key={role.role} withBorder p="md">
        <Stack gap="xs">
          <Group justify="space-between"><Title order={3} size="h4" tt="capitalize">{role.role}</Title><Badge color={['invalid', 'unavailable'].includes(role.status) ? 'red' : role.status === 'missing' ? 'gray' : 'teal'}>{role.status}</Badge></Group>
          <Text fw={600}>{setting(role.model, 'Model')} · {setting(role.effort, 'Effort')}</Text>
          <Text size="sm" style={{ overflowWrap: 'anywhere' }}>Source: {role.source ?? 'No role file'}</Text>
          {role.problems.map((problem) => <Alert key={problem} color="red">{problem}</Alert>)}
        </Stack>
      </Paper>)}
    </>}
  </Stack>;
}
