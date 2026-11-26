# Thread Message Windowing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "load more history" button to the Thread conversation view, showing only recent messages by default and loading older messages on demand.

**Architecture:** Use assistant-ui's `unstable_useThreadMessageIds` + `Unstable_MessageById` for custom message windowing. Add `visibleMessageCount` state to the studio store and a "Thread" tab to the settings dialog.

**Tech Stack:** React, Zustand, assistant-ui primitives, shadcn/ui components

## Global Constraints

- assistant-ui `unstable_*` APIs are experimental; pin version and monitor updates
- Default visible message count: 20 (configurable 10-100 in settings)
- "Load more" increments by 20 messages per click
- Session switch resets visible count to default

---

## File Structure

| File | Purpose |
|------|---------|
| `apps/web/store/studio-store.ts` | Add `visibleMessageCount` state and actions |
| `apps/web/components/assistant-ui/elements/thread.aui.tsx` | Add windowing logic and "Load more" button |
| `apps/web/components/studio/settings-dialog.tsx` | Add "Thread" tab with visible count setting |
| `apps/web/components/studio/__tests__/thread-windowing.test.tsx` | Unit tests for windowing logic |
| `apps/web/components/studio/__tests__/settings-thread.test.tsx` | Unit tests for Thread settings |

---

### Task 1: Add visibleMessageCount to Studio Store

**Files:**
- Modify: `apps/web/store/studio-store.ts:39-135` (State type and actions)
- Modify: `apps/web/store/studio-store.ts:137-155` (Initial state)
- Test: `apps/web/components/studio/__tests__/studio-store-windowing.test.ts`

**Interfaces:**
- Consumes: None (this is the first task)
- Produces: `useStudioStore.visibleMessageCount`, `useStudioStore.loadMoreHistory()`, `useStudioStore.resetVisibleMessageCount()`

- [ ] **Step 1: Write the failing test**

```typescript
// apps/web/components/studio/__tests__/studio-store-windowing.test.ts
import { useStudioStore } from "@/store/studio-store";

describe("studio store - thread windowing", () => {
  beforeEach(() => {
    useStudioStore.setState({
      visibleMessageCount: 20,
    });
  });

  it("has default visibleMessageCount of 20", () => {
    const state = useStudioStore.getState();
    expect(state.visibleMessageCount).toBe(20);
  });

  it("loadMoreHistory increases visibleMessageCount by 20", () => {
    const { loadMoreHistory } = useStudioStore.getState();
    loadMoreHistory();
    expect(useStudioStore.getState().visibleMessageCount).toBe(40);
  });

  it("loadMoreHistory can be called multiple times", () => {
    const { loadMoreHistory } = useStudioStore.getState();
    loadMoreHistory();
    loadMoreHistory();
    expect(useStudioStore.getState().visibleMessageCount).toBe(60);
  });

  it("resetVisibleMessageCount resets to default 20", () => {
    useStudioStore.setState({ visibleMessageCount: 60 });
    const { resetVisibleMessageCount } = useStudioStore.getState();
    resetVisibleMessageCount();
    expect(useStudioStore.getState().visibleMessageCount).toBe(20);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -w @gps/web -- --testPathPattern="studio-store-windowing"`
Expected: FAIL with "visibleMessageCount is not defined"

- [ ] **Step 3: Write minimal implementation**

```typescript
// apps/web/store/studio-store.ts

// Add to State type (after line 84):
  visibleMessageCount: number;

// Add to actions type (after line 134):
  loadMoreHistory: () => void;
  resetVisibleMessageCount: () => void;

// Add to initial state (after line 154):
  visibleMessageCount: 20,

// Add actions (after line 155):
  loadMoreHistory: () => set((state) => ({ 
    visibleMessageCount: state.visibleMessageCount + 20 
  })),
  resetVisibleMessageCount: () => set({ visibleMessageCount: 20 }),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -w @gps/web -- --testPathPattern="studio-store-windowing"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/web/store/studio-store.ts apps/web/components/studio/__tests__/studio-store-windowing.test.ts
git commit -m "feat: add visibleMessageCount state to studio store"
```

---

### Task 2: Add Thread Settings Tab

**Files:**
- Modify: `apps/web/components/studio/settings-dialog.tsx:132-138` (TabsList)
- Modify: `apps/web/components/studio/settings-dialog.tsx:278-280` (Add TabsContent)
- Test: `apps/web/components/studio/__tests__/settings-thread.test.tsx`

**Interfaces:**
- Consumes: `useStudioStore.visibleMessageCount`, `useStudioStore.resetVisibleMessageCount`
- Produces: Settings UI for `thread.visibleMessageCount`

- [ ] **Step 1: Write the failing test**

```typescript
// apps/web/components/studio/__tests__/settings-thread.test.tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SettingsDialog } from "@/components/studio/settings-dialog";
import { useStudioStore } from "@/store/studio-store";

// Mock fetchSettings and updateSettings
jest.mock("@gps/transport-client", () => ({
  fetchSettings: jest.fn().mockResolvedValue({
    model: {},
    subagents: {},
    thread: { visibleMessageCount: 20 },
  }),
  updateSettings: jest.fn().mockImplementation((_, patch) => 
    Promise.resolve({ model: {}, subagents: {}, ...patch })
  ),
  DEFAULT_SETTINGS_API: "/api/settings",
}));

describe("Settings Dialog - Thread tab", () => {
  beforeEach(() => {
    useStudioStore.setState({ settingsOpen: true });
  });

  it("renders Thread tab", async () => {
    render(<SettingsDialog />);
    expect(screen.getByRole("tab", { name: /thread/i })).toBeInTheDocument();
  });

  it("shows visible message count input", async () => {
    render(<SettingsDialog />);
    await screen.findByRole("tab", { name: /thread/i });
    // Click Thread tab
    await userEvent.click(screen.getByRole("tab", { name: /thread/i }));
    expect(screen.getByLabelText(/visible messages/i)).toBeInTheDocument();
  });

  it("shows reset button", async () => {
    render(<SettingsDialog />);
    await screen.findByRole("tab", { name: /thread/i });
    await userEvent.click(screen.getByRole("tab", { name: /thread/i }));
    expect(screen.getByRole("button", { name: /reset/i })).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -w @gps/web -- --testPathPattern="settings-thread"`
Expected: FAIL with "Thread tab not found"

- [ ] **Step 3: Write minimal implementation**

```typescript
// apps/web/components/studio/settings-dialog.tsx

// Add state for thread settings (after line 41):
  const [threadVisibleCount, setThreadVisibleCount] = React.useState("");
  const [threadVisibleCountCleared, setThreadVisibleCountCleared] = React.useState(false);

// Add to useEffect (after line 61):
        const t = next.thread?.visibleMessageCount;
        setThreadVisibleCount(t === undefined ? "" : String(t));
        setThreadVisibleCountCleared(false);

// Add to save function (after line 90):
    if (!(threadVisibleCount === "" && !threadVisibleCountCleared)) {
      patch.thread = {
        visibleMessageCount: threadVisibleCount === "" ? null : Number(threadVisibleCount),
      };
    }

// Add to TabsList (after line 138):
            <TabsTrigger value="thread">Thread</TabsTrigger>

// Add TabsContent (after line 277):
          <TabsContent value="thread" className="min-h-0 space-y-6 overflow-y-auto pr-1">
            {status === "loading" ? (
              <p className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" />
                Loading…
              </p>
            ) : (
              <>
                <section className="space-y-3">
                  <h3 className="text-sm font-semibold">Thread</h3>
                  <p className="text-xs text-muted-foreground">
                    Number of messages to show by default in the conversation view.
                  </p>
                  <label className="grid gap-1 text-xs">
                    <span className="text-muted-foreground">Visible messages (10–100; default 20)</span>
                    <Input
                      type="number"
                      min={10}
                      max={100}
                      value={threadVisibleCount}
                      placeholder="20"
                      onChange={(e) => {
                        setThreadVisibleCount(e.target.value.trim());
                        setThreadVisibleCountCleared(false);
                      }}
                    />
                  </label>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setThreadVisibleCount("");
                      setThreadVisibleCountCleared(true);
                    }}
                  >
                    Reset to default (20)
                  </Button>
                </section>
                <div className="flex items-center gap-3">
                  <Button type="button" onClick={() => void save()} disabled={status === "saving"}>
                    {status === "saving" ? <Loader2 className="size-4 animate-spin" /> : null}
                    Save
                  </Button>
                  {status === "saved" ? (
                    <span className="text-xs text-muted-foreground">Saved.</span>
                  ) : null}
                  {error ? <span className="text-xs text-destructive">{error}</span> : null}
                </div>
              </>
            )}
          </TabsContent>
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -w @gps/web -- --testPathPattern="settings-thread"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/web/components/studio/settings-dialog.tsx apps/web/components/studio/__tests__/settings-thread.test.tsx
git commit -m "feat: add Thread settings tab for visible message count"
```

---

### Task 3: Add Windowing Logic to Thread Component

**Files:**
- Modify: `apps/web/components/assistant-ui/elements/thread.aui.tsx:183-190` (Messages rendering)
- Test: `apps/web/components/studio/__tests__/thread-windowing.test.tsx`

**Interfaces:**
- Consumes: `useStudioStore.visibleMessageCount`, `useStudioStore.loadMoreHistory`
- Produces: Thread with windowed messages and "Load more" button

- [ ] **Step 1: Write the failing test**

```typescript
// apps/web/components/studio/__tests__/thread-windowing.test.tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Thread } from "@/components/assistant-ui/elements/thread.aui";
import { useStudioStore } from "@/store/studio-store";

// Mock assistant-ui hooks
jest.mock("@assistant-ui/react", () => ({
  ...jest.requireActual("@assistant-ui/react"),
  unstable_useThreadMessageIds: jest.fn(),
  ThreadPrimitive: {
    ...jest.requireActual("@assistant-ui/react").ThreadPrimitive,
    Unstable_MessageById: ({ messageId }: { messageId: string }) => (
      <div data-testid={`message-${messageId}`}>Message {messageId}</div>
    ),
  },
}));

describe("Thread - message windowing", () => {
  beforeEach(() => {
    useStudioStore.setState({ visibleMessageCount: 20 });
    (require("@assistant-ui/react").unstable_useThreadMessageIds as jest.Mock)
      .mockReturnValue(["msg-1", "msg-2", "msg-3", "msg-4", "msg-5"]);
  });

  it("renders only visible messages", () => {
    useStudioStore.setState({ visibleMessageCount: 3 });
    render(<Thread />);
    expect(screen.queryByTestId("message-msg-1")).not.toBeInTheDocument();
    expect(screen.queryByTestId("message-msg-2")).not.toBeInTheDocument();
    expect(screen.getByTestId("message-msg-3")).toBeInTheDocument();
    expect(screen.getByTestId("message-msg-4")).toBeInTheDocument();
    expect(screen.getByTestId("message-msg-5")).toBeInTheDocument();
  });

  it("shows Load more button when messages are hidden", () => {
    useStudioStore.setState({ visibleMessageCount: 3 });
    render(<Thread />);
    expect(screen.getByRole("button", { name: /load more/i })).toBeInTheDocument();
  });

  it("hides Load more button when all messages are visible", () => {
    useStudioStore.setState({ visibleMessageCount: 10 });
    render(<Thread />);
    expect(screen.queryByRole("button", { name: /load more/i })).not.toBeInTheDocument();
  });

  it("Load more button shows hidden count", () => {
    useStudioStore.setState({ visibleMessageCount: 3 });
    render(<Thread />);
    expect(screen.getByRole("button", { name: /2 messages/i })).toBeInTheDocument();
  });

  it("clicking Load more increases visible count", async () => {
    useStudioStore.setState({ visibleMessageCount: 3 });
    render(<Thread />);
    await userEvent.click(screen.getByRole("button", { name: /load more/i }));
    expect(useStudioStore.getState().visibleMessageCount).toBe(23);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -w @gps/web -- --testPathPattern="thread-windowing"`
Expected: FAIL with "unstable_useThreadMessageIds is not defined"

- [ ] **Step 3: Write minimal implementation**

```typescript
// apps/web/components/assistant-ui/elements/thread.aui.tsx

// Add import (after line 40):
import { unstable_useThreadMessageIds } from "@assistant-ui/react";

// Add to ThreadRoot component (replace lines 183-190):
          <div
            data-slot="aui_message-group"
            className="mb-10 flex flex-col gap-y-6 empty:hidden"
          >
            <ThreadMessageWindow />
          </div>

// Add new component (before ThreadMessage):
const ThreadMessageWindow: FC = () => {
  const allIds = unstable_useThreadMessageIds();
  const visibleCount = useStudioStore((s) => s.visibleMessageCount);
  const loadMoreHistory = useStudioStore((s) => s.loadMoreHistory);
  
  const visibleIds = allIds.slice(-visibleCount);
  const hiddenCount = allIds.length - visibleIds.length;

  return (
    <>
      {hiddenCount > 0 && (
        <div className="flex justify-center py-2">
          <Button
            variant="outline"
            size="sm"
            onClick={loadMoreHistory}
            aria-label={`Load more history: ${hiddenCount} messages`}
          >
            Load more history ({hiddenCount} messages)
          </Button>
        </div>
      )}
      {visibleIds.map((id) => (
        <ThreadPrimitive.Unstable_MessageById
          key={id}
          messageId={id}
          components={{ Message: ThreadMessage }}
        />
      ))}
    </>
  );
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -w @gps/web -- --testPathPattern="thread-windowing"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/web/components/assistant-ui/elements/thread.aui.tsx apps/web/components/studio/__tests__/thread-windowing.test.tsx
git commit -m "feat: add message windowing to Thread with Load more button"
```

---

### Task 4: Reset Visible Count on Session Switch

**Files:**
- Modify: `apps/web/store/studio-store.ts:203-220` (setScope action)

**Interfaces:**
- Consumes: `resetVisibleMessageCount()` from Task 1
- Produces: Automatic reset when session changes

- [ ] **Step 1: Write the failing test**

```typescript
// Add to apps/web/components/studio/__tests__/studio-store-windowing.test.ts

describe("session switch resets visibleMessageCount", () => {
  it("resets visibleMessageCount when scope changes", () => {
    useStudioStore.setState({ 
      visibleMessageCount: 60,
      projectId: "proj-1",
      activeSessionId: "sess-1",
    });
    
    const { setScope } = useStudioStore.getState();
    setScope({ projectId: "proj-1", sessionId: "sess-2" });
    
    expect(useStudioStore.getState().visibleMessageCount).toBe(20);
  });

  it("does not reset when same session", () => {
    useStudioStore.setState({ 
      visibleMessageCount: 60,
      projectId: "proj-1",
      activeSessionId: "sess-1",
    });
    
    const { setScope } = useStudioStore.getState();
    setScope({ projectId: "proj-1", sessionId: "sess-1" });
    
    expect(useStudioStore.getState().visibleMessageCount).toBe(60);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -w @gps/web -- --testPathPattern="studio-store-windowing"`
Expected: FAIL with "visibleMessageCount not reset"

- [ ] **Step 3: Write minimal implementation**

```typescript
// apps/web/store/studio-store.ts

// Modify setScope action (around line 203):
  setScope: (scope, memory) =>
    set((state) => {
      const sessionChanged = state.activeSessionId !== scope.sessionId;
      return {
        ...scope,
        visibleMessageCount: sessionChanged ? 20 : state.visibleMessageCount,
      };
    }),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -w @gps/web -- --testPathPattern="studio-store-windowing"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/web/store/studio-store.ts apps/web/components/studio/__tests__/studio-store-windowing.test.ts
git commit -m "feat: reset visibleMessageCount on session switch"
```

---

### Task 5: Integration Testing

**Files:**
- Test: `apps/web/components/studio/__tests__/thread-windowing-integration.test.tsx`

**Interfaces:**
- Consumes: All previous tasks
- Produces: End-to-end integration tests

- [ ] **Step 1: Write integration test**

```typescript
// apps/web/components/studio/__tests__/thread-windowing-integration.test.tsx
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Thread } from "@/components/assistant-ui/elements/thread.aui";
import { useStudioStore } from "@/store/studio-store";

jest.mock("@assistant-ui/react", () => ({
  ...jest.requireActual("@assistant-ui/react"),
  unstable_useThreadMessageIds: jest.fn(),
}));

describe("Thread windowing integration", () => {
  const mockIds = Array.from({ length: 50 }, (_, i) => `msg-${i}`);

  beforeEach(() => {
    useStudioStore.setState({ visibleMessageCount: 20 });
    (require("@assistant-ui/react").unstable_useThreadMessageIds as jest.Mock)
      .mockReturnValue(mockIds);
  });

  it("shows 20 messages by default with 30 hidden", () => {
    render(<Thread />);
    expect(screen.getByText(/30 messages/i)).toBeInTheDocument();
    // First visible message is msg-30
    expect(screen.getByTestId("message-msg-30")).toBeInTheDocument();
    // Last message is msg-49
    expect(screen.getByTestId("message-msg-49")).toBeInTheDocument();
  });

  it("clicking Load more reveals 20 more messages", async () => {
    render(<Thread />);
    await userEvent.click(screen.getByRole("button", { name: /load more/i }));
    // Now visibleCount is 40, hidden is 10
    expect(screen.getByText(/10 messages/i)).toBeInTheDocument();
    expect(screen.getByTestId("message-msg-10")).toBeInTheDocument();
  });

  it("clicking Load more twice shows all messages", async () => {
    render(<Thread />);
    await userEvent.click(screen.getByRole("button", { name: /load more/i }));
    await userEvent.click(screen.getByRole("button", { name: /load more/i }));
    // Now visibleCount is 60, all 50 messages visible
    expect(screen.queryByRole("button", { name: /load more/i })).not.toBeInTheDocument();
    expect(screen.getByTestId("message-msg-0")).toBeInTheDocument();
  });

  it("settings change affects thread", async () => {
    render(<Thread />);
    useStudioStore.setState({ visibleMessageCount: 10 });
    // Re-render should show 10 messages
    expect(screen.getByText(/40 messages/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run integration test**

Run: `npm run test -w @gps/web -- --testPathPattern="thread-windowing-integration"`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add apps/web/components/studio/__tests__/thread-windowing-integration.test.tsx
git commit -m "test: add integration tests for thread windowing"
```

---

### Task 6: Run Full Test Suite

**Files:**
- None (verification only)

- [ ] **Step 1: Run all web tests**

Run: `npm run test -w @gps/web`
Expected: All tests pass

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: No type errors

- [ ] **Step 3: Run build**

Run: `npm run build`
Expected: Build succeeds

---

## Verification Checklist

- [ ] Messages are windowed correctly (only visibleCount shown)
- [ ] "Load more" button appears when messages are hidden
- [ ] Button shows correct hidden count
- [ ] Clicking button increases visible count by 20
- [ ] Settings dialog has Thread tab with visible count input
- [ ] Settings change persists and affects Thread
- [ ] Session switch resets visible count to 20
- [ ] All tests pass
- [ ] No type errors
- [ ] Build succeeds
