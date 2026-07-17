import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

interface AttendeeGroup {
  name?: string;
  attendees: string[];
}

interface AttendeeGroups {
  groups: AttendeeGroup[];
}

export function useAttendeeGroups() {
  const [groups, setGroups] = useState<AttendeeGroup[]>([]);

  useEffect(() => {
    let alive = true;
    invoke<AttendeeGroups>("cmd_read_attendee_groups")
      .then((data) => {
        if (alive) setGroups(data.groups);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  const persist = (next: AttendeeGroup[]) => {
    setGroups(next);
    void invoke("cmd_write_attendee_groups", { attendeeGroups: { groups: next } }).catch(() => {});
  };

  const saveGroup = (attendees: string[], name: string) => {
    const trimmedName = name.trim();
    persist([
      ...groups,
      {
        ...(trimmedName ? { name: trimmedName } : {}),
        attendees: [...attendees],
      },
    ]);
  };

  const removeGroup = (index: number) => {
    persist(groups.filter((_, i) => i !== index));
  };

  return { groups, saveGroup, removeGroup };
}
