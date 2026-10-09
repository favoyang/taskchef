import { Combobox, Group, InputBase, Text, useCombobox } from "@mantine/core";
import { IconCheck, IconChevronDown, IconFolder, IconSearch } from "@tabler/icons-react";
import { useState } from "react";

export interface ProjectOption { value: string; label: string; path?: string; }

export function ProjectPicker({ data, value, onChange }: { data: ProjectOption[]; value: string; onChange: (value: string) => void }) {
  const [search, setSearch] = useState("");
  const store = useCombobox({
    onDropdownClose: () => { store.resetSelectedOption(); setSearch(""); store.focusTarget(); },
    onDropdownOpen: () => { store.focusSearchInput(); },
  });
  const selected = data.find((item) => item.value === value);
  const query = search.trim().toLocaleLowerCase();
  const options = data.filter((item) => `${item.label} ${item.path ?? ""}`.toLocaleLowerCase().includes(query));
  return <Combobox store={store} onOptionSubmit={(next) => { onChange(String(next)); store.closeDropdown(); }} position="bottom-start" width={310} withinPortal>
    <Combobox.Target targetType="button" withExpandedAttribute>
      <InputBase component="button" type="button" pointer size="xs" aria-label="Project" role="combobox" onClick={() => store.toggleDropdown()}
        leftSection={<IconFolder size={15} aria-hidden />} rightSection={<IconChevronDown size={13} aria-hidden />} className="next-project-trigger">
        <span>{selected?.label ?? "All projects"}</span>
      </InputBase>
    </Combobox.Target>
    <Combobox.Dropdown className="next-project-dropdown">
      <Combobox.Search aria-label="Search projects" placeholder="Search projects" value={search} leftSection={<IconSearch size={15} aria-hidden />}
        onChange={(event) => { setSearch(event.currentTarget.value); store.resetSelectedOption(); }} />
      <Combobox.Options aria-label="Projects" className="next-project-options">
          {options.map((item) => <Combobox.Option key={item.value} value={item.value} active={item.value === value} aria-selected={item.value === value} title={item.path}>
            <Group gap="xs" wrap="nowrap"><IconFolder size={16} aria-hidden /><Text size="sm" truncate style={{ flex: 1 }}>{item.label}</Text>{item.value === value && <IconCheck size={16} aria-hidden />}</Group>
          </Combobox.Option>)}
          {!options.length && <Combobox.Empty>No projects found</Combobox.Empty>}
      </Combobox.Options>
    </Combobox.Dropdown>
  </Combobox>;
}
