import { ActionIcon, Combobox, Group, InputBase, Text, useCombobox } from "@mantine/core";
import { IconCheck, IconChevronDown, IconFolder, IconSearch, IconHistory, IconSortAscendingLetters, IconSortDescendingLetters } from "@tabler/icons-react";
import { useState } from "react";

export interface ProjectOption { value: string; label: string; path?: string; updatedAt?: number; }

export function ProjectPicker({ data, value, onChange }: { data: ProjectOption[]; value: string; onChange: (value: string) => void }) {
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<"recent" | "az" | "za">("recent");
  const sortLabel = sort === "recent" ? "Most recent" : sort === "az" ? "A–Z" : "Z–A";
  const nextLabel = sort === "recent" ? "A–Z" : sort === "az" ? "Z–A" : "Most recent";
  const SortIcon = sort === "recent" ? IconHistory : sort === "az" ? IconSortAscendingLetters : IconSortDescendingLetters;
  const store = useCombobox({
    onDropdownClose: () => { store.resetSelectedOption(); setSearch(""); store.focusTarget(); },
    onDropdownOpen: () => { store.focusSearchInput(); },
  });
  const selected = data.find((item) => item.value === value);
  const query = search.trim().toLocaleLowerCase();
  const ordered = [...data].sort((a, b) => {
    const rank = (item: ProjectOption) => item.value === "" ? 0 : item.value === "projectless" ? 2 : 1;
    if (rank(a) !== rank(b)) return rank(a) - rank(b);
    const alphabet = a.label.localeCompare(b.label, undefined, { sensitivity: "base", numeric: true }) || a.value.localeCompare(b.value);
    return sort === "recent" ? (b.updatedAt ?? 0) - (a.updatedAt ?? 0) || alphabet : sort === "az" ? alphabet : -alphabet;
  });
  const options = ordered.filter((item) => `${item.label} ${item.path ?? ""}`.toLocaleLowerCase().includes(query));
  return <Combobox store={store} onOptionSubmit={(next) => { onChange(String(next)); store.closeDropdown(); }} position="bottom-start" width={310} withinPortal>
    <Combobox.Target targetType="button" withExpandedAttribute>
      <InputBase component="button" type="button" pointer size="xs" aria-label="Project" role="combobox" onClick={() => store.toggleDropdown()}
        leftSection={<IconFolder size={15} aria-hidden />} rightSection={<IconChevronDown size={13} aria-hidden />} className="next-project-trigger">
        <span>{selected?.label ?? "All projects"}</span>
      </InputBase>
    </Combobox.Target>
    <Combobox.Dropdown className="next-project-dropdown">
      <Combobox.Search aria-label="Search projects" placeholder="Search projects" value={search} leftSection={<IconSearch size={15} aria-hidden />}
        rightSectionPointerEvents="all" rightSectionWidth={34}
        rightSection={<span className="next-project-sort"><ActionIcon variant="subtle" size="sm" aria-label={`Sort projects: ${sortLabel}. Switch to ${nextLabel}`} title={`Sort: ${sortLabel}. Click for ${nextLabel}`}
          onMouseDown={(event) => event.preventDefault()} onClick={() => { setSort(sort === "recent" ? "az" : sort === "az" ? "za" : "recent"); store.resetSelectedOption(); }}>
          <SortIcon size={17} aria-hidden />
        </ActionIcon></span>}
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
