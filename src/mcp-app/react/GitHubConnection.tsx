import { ActionIcon, Alert, Button, Group, Modal, Stack, Text } from "@mantine/core";
import { IconBrandGithub } from "@tabler/icons-react";
import { useEffect, useState } from "react";

export interface GitHubAuth {
  configured: boolean;
  connected: boolean;
  login: string | null;
  error?: string;
  pending?: { userCode: string; verificationUrl: string; expiresAt: number };
}
export function GitHubConnection({ auth, request, openLink, refresh, openSettings, openSignal = 0, inline = false, hideTrigger = false }: {
  openSignal?: number;
  inline?: boolean;
  hideTrigger?: boolean;
  auth: GitHubAuth;
  request: (action: "status" | "start" | "poll" | "disconnect") => Promise<GitHubAuth>;
  openLink: (url: string) => Promise<unknown>;
  refresh: () => Promise<unknown>;
  openSettings: () => Promise<unknown>;
}) {
  const [opened, setOpened] = useState(inline);
  const [current, setCurrent] = useState(auth);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { setCurrent(auth); }, [auth]);
  useEffect(() => { if (openSignal > 0) { setError(null); setOpened(true); } }, [openSignal]);
  useEffect(() => {
    if (!opened || !current.pending || document.visibilityState === "hidden") return;
    let cancelled = false;
    let polling = false;
    const timer = window.setInterval(async () => {
      if (polling || document.visibilityState === "hidden") return;
      polling = true;
      try {
        const next = await request("poll");
        if (cancelled) return;
        setCurrent(next);
        if (next.connected) await refresh();
      } catch (cause) { if (!cancelled) { setError(String(cause)); setCurrent((value) => ({ ...value, pending: undefined })); } }
      finally { polling = false; }
    }, 5000);
    return () => { cancelled = true; window.clearInterval(timer); };
  // Snapshot polling supplies a new pending object; the code itself stays stable.
  }, [opened, current.pending?.userCode, request, refresh]);
  async function action(operation: () => Promise<unknown>) {
    setBusy(true); setError(null);
    try { await operation(); } catch (cause) { setError(String(cause)); }
    finally { setBusy(false); }
  }
  const controls = <Stack gap="sm">
        {(error || current.error) && <Alert color="red" role="alert">{error || current.error}</Alert>}
        {!current.configured ? <>
          <Text size="sm">GitHub sign-in needs a registered GitHub App. Set its public client ID in plugin settings.</Text>
          <Button onClick={() => void action(openSettings)}>Open plugin settings</Button>
        </> : current.connected ? <>
          <Text size="sm">Connected as <strong>{current.login}</strong>.</Text>
          <Text size="sm">TaskChef checks latest-turn PRs in your project and time filters. Status is cached for one minute; merged PRs stay cached until TaskChef restarts.</Text>
          <Button variant="subtle" onClick={() => void action(() => openLink("https://github.com/settings/installations"))}>Manage repository access</Button>
          <Button disabled={busy} variant="default" onClick={() => void action(async () => { setCurrent(await request("disconnect")); await refresh(); })}>Disconnect this computer</Button>
          <Text c="dimmed" size="xs">Disconnect removes the local token. You can revoke GitHub authorization in your GitHub settings.</Text>
        </> : current.pending ? <>
          <Text size="sm">Enter this code on GitHub:</Text>
          <Text fw={700} size="xl" style={{ letterSpacing: "0.1em" }}>{current.pending.userCode}</Text>
          <Button disabled={busy} onClick={() => void action(() => openLink(current.pending!.verificationUrl))}>Open GitHub</Button>
          <Text c="dimmed" size="xs">Waiting for your approval. Keep this dialog open. The code expires in 15 minutes.</Text>
        </> : <>
          <Text size="sm">Read PR and CI status for your selected repositories. Your sign-in stays in this computer’s credential store. Chat messages are not sent to GitHub.</Text>
          <Group><Button disabled={busy} onClick={() => void action(async () => setCurrent(await request("start")))}>Sign in with GitHub</Button>
            <Button variant="subtle" onClick={() => void action(() => openLink("https://github.com/settings/installations"))}>Repository access</Button></Group>
        </>}
  </Stack>;
  if (inline) return controls;
  return <>
    {!hideTrigger && <ActionIcon aria-label="GitHub connection" title={auth.connected ? `GitHub: ${auth.login}` : "Connect GitHub"} variant="subtle" onClick={() => { setError(null); setOpened(true); }}><IconBrandGithub size={17} /></ActionIcon>}
    <Modal opened={opened} onClose={() => setOpened(false)} title="GitHub PR status" centered>{controls}</Modal>
  </>;
}
