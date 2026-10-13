// Where recipes or scenarios come from: once a folder is open it is a small chip in the page header
// ("📁 recipes · 6"), with Change and Check all next to it. Before that, a field to open one.
import { Box, Button, Card, Flex, Popover, Text, TextField, Tooltip } from '@radix-ui/themes';
import { FolderOpen, FolderSimple, Stethoscope } from '@phosphor-icons/react';
import { useEffect, useState } from 'react';

interface Props {
  path: string;
  count: number;
  noun: string;
  placeholder: string;
  busy: 'open' | 'check' | null;
  onOpen: (path: string) => Promise<void>;
  onCheck: () => void;
}

const lastPart = (p: string) => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p;

function PathField({ value, onChange, onSubmit, placeholder, busy, label }: { value: string; onChange: (v: string) => void; onSubmit: () => void; placeholder: string; busy: boolean; label: string }) {
  return (
    <form onSubmit={(e) => { e.preventDefault(); if (value) onSubmit(); }}>
      <Flex gap="2" wrap="wrap">
        <Box flexGrow="1" minWidth="240px">
          <TextField.Root value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} aria-label={label} className="mono" autoFocus />
        </Box>
        <Button type="submit" loading={busy} disabled={!value}><FolderOpen /> Open</Button>
      </Flex>
    </form>
  );
}

/** The chip and its buttons, for the page header. */
export function SourceChip({ path, count, noun, placeholder, busy, onOpen, onCheck }: Props) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState(path);
  useEffect(() => { if (open) setValue(path); }, [open, path]);
  if (!path) return null;
  return (
    <Flex gap="2" align="center" wrap="wrap">
      <Popover.Root open={open} onOpenChange={setOpen}>
        <Tooltip content={path}>
          <Popover.Trigger>
            <button type="button" className="source-chip" aria-label={`${noun} folder: ${path}. Change`}>
              <FolderSimple weight="fill" /> <span className="source-name">{lastPart(path)}</span>
              <span className="source-count">{count} {noun}</span>
            </button>
          </Popover.Trigger>
        </Tooltip>
        <Popover.Content width="520px" maxWidth="calc(100vw - 32px)">
          <Text as="p" size="2" weight="medium" mb="1">Open another folder</Text>
          <Text as="p" size="1" color="gray" mb="3">A folder of files, or one file. Remembered for this database.</Text>
          <PathField value={value} onChange={setValue} placeholder={placeholder} busy={busy === 'open'} label={`${noun} folder`}
            onSubmit={() => void onOpen(value).then(() => setOpen(false))} />
        </Popover.Content>
      </Popover.Root>
      <Button variant="soft" color="gray" onClick={onCheck} loading={busy === 'check'} disabled={count === 0}>
        <Stethoscope /> Check all
      </Button>
    </Flex>
  );
}

/** Before any folder is open: a welcoming card with the field. */
export function SourceSetup({ title, children, placeholder, busy, onOpen, noun }: { title: string; children: React.ReactNode; placeholder: string; busy: boolean; onOpen: (path: string) => Promise<void>; noun: string }) {
  const [value, setValue] = useState('');
  return (
    <Card size="4" className="source-setup">
      <Flex direction="column" gap="3" align="start">
        <span className="tile tile-lg tile-indigo" aria-hidden><FolderOpen /></span>
        <Text as="p" size="5" weight="bold">{title}</Text>
        <Text as="p" size="2" color="gray" style={{ maxWidth: 560 }}>{children}</Text>
        <Box width="100%" maxWidth="640px">
          <PathField value={value} onChange={setValue} placeholder={placeholder} busy={busy} label={`${noun} folder`} onSubmit={() => void onOpen(value)} />
        </Box>
      </Flex>
    </Card>
  );
}
