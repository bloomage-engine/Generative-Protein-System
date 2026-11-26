# Thread Message Windowing Design

## Overview

Add a "load more history" feature to the Thread conversation view, allowing users to see only recent messages by default and load older messages on demand.

## Goals

1. Reduce visual clutter in long conversations
2. Improve performance for sessions with many messages
3. Provide a familiar UX pattern (similar to chat apps)
4. Lay groundwork for future time-based filtering

## Non-Goals

- Time-based filtering (deferred to future iteration)
- Message search/filtering
- Virtual scrolling (out of scope)

## Design

### Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Thread View                              │
│  ┌─────────────────────────────────────────────────────┐   │
│  │  [Load more history] (when hidden > 0)              │   │
│  ├─────────────────────────────────────────────────────┤   │
│  │  Message N-K (visible window)                       │   │
│  │  Message N-K+1                                      │   │
│  │  ...                                                │   │
│  │  Message N (latest)                                 │   │
│  ├─────────────────────────────────────────────────────┤   │
│  │  [Composer]                                         │   │
│  └─────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

### Component Changes

#### 1. Thread Component (`apps/web/components/assistant-ui/elements/thread.aui.tsx`)

**Current behavior**: Renders all messages via `ThreadPrimitive.Messages`

**New behavior**:
- Use `unstable_useThreadMessageIds` to get all message IDs
- Calculate `visibleIds = allIds.slice(-visibleCount)`
- Render only visible messages using `ThreadPrimitive.Unstable_MessageById`
- Show "Load more history" button at top when `hiddenCount > 0`

**Implementation**:
```tsx
import { unstable_useThreadMessageIds } from "@assistant-ui/core";
import { ThreadPrimitiveUnstable_MessageById as MessageById } from "@assistant-ui/core";

// In component:
const allIds = unstable_useThreadMessageIds();
const visibleCount = useStudioStore(s => s.visibleMessageCount);
const visibleIds = allIds.slice(-visibleCount);
const hiddenCount = allIds.length - visibleIds.length;

return (
  <ThreadPrimitive.Viewport>
    {hiddenCount > 0 && (
      <Button onClick={() => loadMoreHistory()}>
        Load more history ({hiddenCount} messages)
      </Button>
    )}
    {visibleIds.map(id => (
      <MessageById key={id} messageId={id} components={MESSAGE_COMPONENTS} />
    ))}
    <ThreadPrimitive.ViewportFooter>
      {/* Composer */}
    </ThreadPrimitive.ViewportFooter>
  </ThreadPrimitive.Viewport>
);
```

#### 2. Studio Store (`apps/web/store/studio-store.ts`)

**New state**:
```typescript
interface StudioState {
  // ... existing state
  visibleMessageCount: number;
}

interface StudioActions {
  // ... existing actions
  setVisibleMessageCount: (count: number) => void;
  loadMoreHistory: () => void;
}
```

**Implementation**:
```typescript
// State
visibleMessageCount: 20,

// Actions
setVisibleMessageCount: (count) => set({ visibleMessageCount: count }),
loadMoreHistory: () => set((state) => ({ 
  visibleMessageCount: state.visibleMessageCount + 20 
})),
```

#### 3. Settings Dialog (`apps/web/components/studio/settings-dialog.tsx`)

**New tab or section**: "Thread" settings

**New setting**:
- Key: `thread.visibleMessageCount`
- Default: 20
- Range: 10-100
- Step: 10

**Implementation**:
```typescript
// In Settings Dialog
<TabsList>
  {/* ... existing tabs */}
  <TabsTrigger value="thread">Thread</TabsTrigger>
</TabsList>

<TabsContent value="thread">
  <div className="space-y-4">
    <div>
      <Label>Visible Messages</Label>
      <p className="text-sm text-muted-foreground">
        Number of messages to show by default
      </p>
      <Input
        type="number"
        min={10}
        max={100}
        step={10}
        value={settings.thread?.visibleMessageCount ?? 20}
        onChange={(e) => updateSetting('thread.visibleMessageCount', Number(e.target.value))}
      />
    </div>
  </div>
</TabsContent>
```

### Settings Storage

Reuse existing settings pattern:
- **Server-side**: Stored in `GPS_SETTINGS_PATH` (default `<userData>/settings.json`)
- **Client-side**: Fetched via `useSettings` hook
- **API**: `GET /api/settings`, `PATCH /api/settings`

### UI Behavior

1. **Initial load**: Show last `visibleMessageCount` messages
2. **Scroll to top**: Show "Load more history" button (when hidden messages exist)
3. **Click button**: Increase `visibleMessageCount` by 20, reveal more messages
4. **New message arrives**: Auto-scroll to bottom, maintain window size
5. **Session switch**: Reset `visibleMessageCount` to default (20)

### Edge Cases

1. **Session with < visibleMessageCount messages**: Show all messages, no button
2. **Rapid clicking**: Debounce or disable button while updating
3. **Mobile UX**: Button should be easily tappable
4. **Accessibility**: Button should have proper ARIA labels

## Extension Points

### Time-Based Filtering (Future)

1. **Add message timestamps**:
   - Modify `Message` type: `createdAt?: string`
   - Server stamps messages on `add-message`
   - Runtime adapters add timestamps when creating messages

2. **Time filtering logic**:
   - Calculate `windowMs = visibleWindowHours * 3600000`
   - Filter `message.createdAt > now - windowMs`
   - Setting key: `thread.visibleWindowHours`

3. **Migration path**:
   - Current: Count-based (no timestamp required)
   - Future: Time-based (timestamp optional, falls back to count)
   - API compatible: Both use same UI components

## Testing

1. **Unit tests**:
   - Store: `visibleMessageCount` state management
   - Settings: `thread.visibleMessageCount` persistence

2. **Integration tests**:
   - Thread renders correct number of messages
   - "Load more" button appears/disappears correctly
   - Settings change reflected in Thread

3. **E2E tests**:
   - Load session with many messages
   - Verify initial window size
   - Click "Load more" and verify more messages appear
   - Switch sessions and verify reset

## Dependencies

- `@assistant-ui/core`: `unstable_useThreadMessageIds`, `Unstable_MessageById`
- No new dependencies required

## Risks

1. **assistant-ui instability**: `unstable_*` APIs may change
   - Mitigation: Pin assistant-ui version, monitor updates

2. **Performance**: Rendering many messages on "Load more"
   - Mitigation: Limit max visible count (100)

3. **Scroll position**: Maintaining position when loading more
   - Mitigation: Calculate offset and restore after render

## Rollout

1. **Phase 1**: Implement count-based windowing (this design)
2. **Phase 2**: Add message timestamps to wire format
3. **Phase 3**: Implement time-based filtering (optional)

## References

- assistant-ui ThreadPrimitive: `node_modules/@assistant-ui/core/dist/react/primitives/thread/ThreadMessages.d.ts`
- Subagents window pattern: `apps/web/components/studio/subagents-window.ts`
- Settings pattern: `apps/web/components/studio/settings-dialog.tsx`
