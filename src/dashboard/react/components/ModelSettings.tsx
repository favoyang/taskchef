import { ActionIcon, Alert, Badge, Group, Paper, Select, SimpleGrid, Stack, Text, Title } from '@mantine/core';
import { IconRefresh } from '@tabler/icons-react';
import { useEffect, useState } from 'react';
import { updateModelRole } from '../api';

type ModelOption = { value: string; label: string; efforts: string[] };
type Role = { role: string; source: string | null; displaySource?: string | null; model: unknown; effort: unknown; status: string; problems: string[] };
type Profile = { id: string; roles: Role[]; problems: string[]; modelOptions?: ModelOption[] };

export function ModelSettings() {
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<string | null>(null);
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
  const save = async (role: Role, model: string, effort: string) => {
    setSaving(role.role);
    setError(null);
    try {
      const result = await updateModelRole(role.role, model, effort) as { profile: Profile };
      setProfiles([result.profile]);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Model role could not be saved.');
    } finally {
      setSaving(null);
    }
  };
  return <Stack gap="md" aria-label="Model settings">
    <Group justify="space-between">
      <Title order={2} size="h3">Model roles</Title>
      <ActionIcon aria-label="Refresh" aria-busy={loading} aria-disabled={loading} className="taskchef-icon-button" color="gray" variant="subtle" size="lg" onClick={() => {
        if (loading) return;
        setLoading(true);
        setRevision((value) => value + 1);
      }}><IconRefresh className={loading ? 'taskchef-refresh-spinning' : undefined} size={18} stroke={1.8} /></ActionIcon>
    </Group>
    <Text c="dimmed" size="sm">Your models for planning, implementation, and review.</Text>
    {error && <Alert color="red" role="alert">{error}</Alert>}
    {profile && <>
      {profile.problems.map((problem) => <Alert color="yellow" key={problem}>{problem}</Alert>)}
      {profile.roles.map((role) => <Paper key={role.role} withBorder p="md">
        <Stack gap="xs">
          <Group justify="space-between"><Title order={3} size="h4" tt="capitalize">{role.role}</Title><Badge color={['invalid', 'unavailable'].includes(role.status) ? 'red' : role.status === 'missing' ? 'gray' : 'teal'}>{role.status}</Badge></Group>
          <SimpleGrid cols={{ base: 1, sm: 2 }}>
            <Select label="Model" aria-label={`${role.role} model`} data={profile.modelOptions ?? []} value={typeof role.model === 'string' ? role.model : null} disabled={saving === role.role} allowDeselect={false} searchable onChange={(model) => {
              if (!model) return;
              const option = profile.modelOptions?.find((candidate) => candidate.value === model);
              const effort = typeof role.effort === 'string' && option?.efforts.includes(role.effort) ? role.effort : option?.efforts[0];
              if (effort) void save(role, model, effort);
            }} />
            <Select label="Reasoning effort" aria-label={`${role.role} reasoning effort`} data={(profile.modelOptions?.find((option) => option.value === role.model)?.efforts ?? []).map((value) => ({ value, label: value }))} value={typeof role.effort === 'string' ? role.effort : null} disabled={saving === role.role || typeof role.model !== 'string'} allowDeselect={false} onChange={(effort) => {
              if (effort && typeof role.model === 'string') void save(role, role.model, effort);
            }} />
          </SimpleGrid>
          <Text size="sm" style={{ overflowWrap: 'anywhere' }}>Source: {role.displaySource ?? role.source ?? 'No role file'}</Text>
          {saving === role.role && <Text c="dimmed" size="sm" role="status">Saving…</Text>}
          {role.problems.map((problem) => <Alert key={problem} color="red">{problem}</Alert>)}
        </Stack>
      </Paper>)}
    </>}
  </Stack>;
}
