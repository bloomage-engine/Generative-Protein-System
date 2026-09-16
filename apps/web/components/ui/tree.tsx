"use client";

import {
  createContext,
  useContext,
  type CSSProperties,
  type HTMLAttributes,
  type ReactNode,
} from "react";
import { ChevronDown } from "lucide-react";
import type { ItemInstance, TreeInstance } from "@headless-tree/core";
import { cn } from "@/lib/utils";

const TreeIndentContext = createContext(20);

type TreeItemContextValue = {
  item?: Pick<ItemInstance<unknown>, "isFolder" | "isExpanded" | "isSelected">;
};

const TreeItemContext = createContext<TreeItemContextValue>({});

export function Tree<T>({
  indent = 20,
  tree,
  className,
  style,
  ...props
}: HTMLAttributes<HTMLDivElement> & { indent?: number; tree: TreeInstance<T> }) {
  // Forward the caller's label: `getContainerProps` emits `aria-label` and is
  // spread after `props`, so without this the caller's name is overwritten.
  const label = typeof props["aria-label"] === "string" ? props["aria-label"] : undefined;
  const containerProps = tree.getContainerProps(label);
  return (
    <TreeIndentContext.Provider value={indent}>
      <div
        {...props}
        {...containerProps}
        data-slot="tree"
        style={
          {
            ...(containerProps.style as CSSProperties),
            ...style,
            "--tree-indent": `${indent}px`,
          } as CSSProperties
        }
        className={cn("flex flex-col", className)}
      />
    </TreeIndentContext.Provider>
  );
}

export function TreeItem<T>({
  item,
  className,
  style,
  children,
  ...props
}: HTMLAttributes<HTMLButtonElement> & { item: ItemInstance<T>; children?: ReactNode }) {
  const indent = useContext(TreeIndentContext);
  const itemProps = item.getProps();
  return (
    <TreeItemContext.Provider value={{ item }}>
      <button
        type="button"
        {...props}
        {...itemProps}
        data-slot="tree-item"
        style={
          {
            ...style,
            "--tree-padding": `${item.getItemMeta().level * indent}px`,
          } as CSSProperties
        }
        className={cn(
          "z-10 ps-(--tree-padding) outline-hidden select-none not-last:pb-0.5 focus:z-20 data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
          className,
        )}
        data-focus={item.isFocused()}
        data-folder={item.isFolder()}
        data-selected={item.isSelected()}
        aria-expanded={item.isFolder() ? item.isExpanded() : undefined}
      >
        {children}
      </button>
    </TreeItemContext.Provider>
  );
}

export function TreeItemLabel({ children, className, ...props }: HTMLAttributes<HTMLSpanElement>) {
  const { item } = useContext(TreeItemContext);
  return (
    <span
      data-slot="tree-item-label"
      className={cn(
        "bg-background hover:bg-accent flex items-center gap-1 rounded-md px-2 py-1.5 text-sm transition-colors [&_svg]:pointer-events-none [&_svg]:shrink-0",
        item?.isSelected() && "bg-accent text-accent-foreground",
        className,
      )}
      {...props}
    >
      {item?.isFolder() ? (
        <ChevronDown
          className={cn("text-muted-foreground size-4", !item.isExpanded() && "-rotate-90")}
        />
      ) : null}
      {children}
    </span>
  );
}
