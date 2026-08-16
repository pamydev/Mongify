import { randomUUID } from "node:crypto";
import fs from "fs-extra";
import path from "path";
import {
  B_TREE_MAX_KEYS,
  B_TREE_PAGE_CACHE_SIZE,
  B_TREE_WRITE_CONCURRENCY,
} from "./config";

export interface BTreeReference {
  chunk: string;
  id: string;
}

export interface BTreeChunkSignature {
  name: string;
  size: number;
  modified: number;
}

interface LeafPage {
  format: "mongify-btree-page-v1";
  id: number;
  leaf: true;
  keys: string[];
  values: BTreeReference[][];
  next?: number;
}

interface InternalPage {
  format: "mongify-btree-page-v1";
  id: number;
  leaf: false;
  keys: string[];
  children: number[];
}

type BTreePage = LeafPage | InternalPage;

interface BTreeMetadata {
  format: "mongify-btree-v1";
  field: string;
  generation: string;
  unique: boolean;
  root: number;
  nextPageId: number;
  chunks: BTreeChunkSignature[];
}

interface BuildEntry {
  key: string;
  references: BTreeReference[];
}

interface PageDescriptor {
  id: number;
  firstKey: string;
}

interface ParentStep {
  page: InternalPage;
  childIndex: number;
}

const page_cache = new Map<string, BTreePage>();

export class BTreeIndex {
  private operation_cache = new Map<number, BTreePage>();
  private dirty_pages = new Set<number>();

  private constructor(
    private directory: string,
    private metadata: BTreeMetadata,
  ) {}

  public get unique(): boolean {
    return this.metadata.unique;
  }

  public static async open(
    directory: string,
    expected: {
      field: string;
      generation: string;
      unique: boolean;
      chunks: BTreeChunkSignature[];
    },
  ): Promise<BTreeIndex> {
    const serialized = await fs.readFile(path.join(directory, "metadata.json"), "utf8");
    const metadata: BTreeMetadata = JSON.parse(serialized);
    if (
      metadata?.format !== "mongify-btree-v1" ||
      metadata.field !== expected.field ||
      metadata.generation !== expected.generation ||
      metadata.unique !== expected.unique ||
      !Number.isInteger(metadata.root) ||
      !Number.isInteger(metadata.nextPageId) ||
      JSON.stringify(metadata.chunks) !== JSON.stringify(expected.chunks)
    ) {
      throw new Error(`Invalid B-tree index: ${expected.field}`);
    }

    const index = new BTreeIndex(directory, metadata);
    await index._read_page(metadata.root);
    return index;
  }

  public static async build(
    directory: string,
    options: {
      field: string;
      generation: string;
      unique: boolean;
      chunks: BTreeChunkSignature[];
      entries: Map<string, BTreeReference[]>;
    },
  ): Promise<BTreeIndex> {
    if (!Number.isInteger(B_TREE_MAX_KEYS) || B_TREE_MAX_KEYS < 3) {
      throw new RangeError("B_TREE_MAX_KEYS must be an integer of at least 3");
    }
    if (!Number.isInteger(B_TREE_PAGE_CACHE_SIZE) || B_TREE_PAGE_CACHE_SIZE < 1) {
      throw new RangeError("B_TREE_PAGE_CACHE_SIZE must be a positive integer");
    }
    if (!Number.isInteger(B_TREE_WRITE_CONCURRENCY) || B_TREE_WRITE_CONCURRENCY < 1) {
      throw new RangeError("B_TREE_WRITE_CONCURRENCY must be a positive integer");
    }

    const temporary_directory = `${directory}.${process.pid}.${randomUUID()}.tmp`;
    await fs.remove(temporary_directory);
    await fs.ensureDir(path.join(temporary_directory, "pages"));

    try {
      const sorted: BuildEntry[] = Array.from(options.entries, ([key, references]) => ({
        key,
        references,
      })).sort((left, right) => left.key.localeCompare(right.key));

      if (options.unique) {
        const duplicate = sorted.find(({ references }) => references.length > 1);
        if (duplicate) {
          throw new Error(`Duplicate value for unique index: ${options.field}`);
        }
      }

      let next_page_id = 1;
      let level: PageDescriptor[] = [];
      let previous_leaf: LeafPage | undefined;

      const write_page = async (page: BTreePage) => {
        await fs.writeFile(
          BTreeIndex._page_path(temporary_directory, page.id),
          JSON.stringify(page),
          "utf8",
        );
      };

      if (sorted.length === 0) {
        const root: LeafPage = {
          format: "mongify-btree-page-v1",
          id: next_page_id++,
          leaf: true,
          keys: [],
          values: [],
        };
        await write_page(root);
        level.push({ id: root.id, firstKey: "" });
      } else {
        for (let start = 0; start < sorted.length; start += B_TREE_MAX_KEYS) {
          const group = sorted.slice(start, start + B_TREE_MAX_KEYS);
          const leaf: LeafPage = {
            format: "mongify-btree-page-v1",
            id: next_page_id++,
            leaf: true,
            keys: group.map(({ key }) => key),
            values: group.map(({ references }) => references),
          };
          if (previous_leaf) {
            previous_leaf.next = leaf.id;
            await write_page(previous_leaf);
          }
          previous_leaf = leaf;
          level.push({ id: leaf.id, firstKey: leaf.keys[0] });
        }
        await write_page(previous_leaf!);
      }

      while (level.length > 1) {
        const next_level: PageDescriptor[] = [];
        for (let start = 0; start < level.length; start += B_TREE_MAX_KEYS + 1) {
          const children = level.slice(start, start + B_TREE_MAX_KEYS + 1);
          const page: InternalPage = {
            format: "mongify-btree-page-v1",
            id: next_page_id++,
            leaf: false,
            keys: children.slice(1).map(({ firstKey }) => firstKey),
            children: children.map(({ id }) => id),
          };
          await write_page(page);
          next_level.push({ id: page.id, firstKey: children[0].firstKey });
        }
        level = next_level;
      }

      const metadata: BTreeMetadata = {
        format: "mongify-btree-v1",
        field: options.field,
        generation: options.generation,
        unique: options.unique,
        root: level[0].id,
        nextPageId: next_page_id,
        chunks: options.chunks,
      };
      await fs.writeFile(
        path.join(temporary_directory, "metadata.json"),
        JSON.stringify(metadata),
        "utf8",
      );
      await fs.remove(directory);
      await fs.rename(temporary_directory, directory);
      BTreeIndex.clearCache(directory);
      return new BTreeIndex(directory, metadata);
    } catch (error) {
      await fs.remove(temporary_directory);
      throw error;
    }
  }

  public static clearCache(directory: string): void {
    const prefix = `${directory}${path.sep}`;
    for (const key of page_cache.keys()) {
      if (key.startsWith(prefix)) {
        page_cache.delete(key);
      }
    }
  }

  public async search(key: string): Promise<BTreeReference[]> {
    const { leaf, index } = await this._find_leaf(key);
    return index < leaf.keys.length && leaf.keys[index] === key
      ? leaf.values[index].map((reference) => ({ ...reference }))
      : [];
  }

  public async insertMany(
    entries: Array<{ key: string; reference: BTreeReference }>,
    chunks: BTreeChunkSignature[],
  ): Promise<void> {
    this._begin_operation();
    try {
      for (const entry of entries) {
        await this._insert(entry.key, entry.reference);
      }
      this.metadata.chunks = chunks;
      await this._commit_operation();
    } catch (error) {
      this._end_operation();
      throw error;
    }
  }

  public async replaceReferences(
    previous: Array<{ key: string; reference: BTreeReference }>,
    replacements: Array<{ key: string; reference: BTreeReference }>,
    chunks: BTreeChunkSignature[],
  ): Promise<void> {
    this._begin_operation();
    try {
      for (const entry of previous) {
        await this._remove(entry.key, entry.reference);
      }
      for (const entry of replacements) {
        await this._insert(entry.key, entry.reference);
      }
      this.metadata.chunks = chunks;
      await this._commit_operation();
    } catch (error) {
      this._end_operation();
      throw error;
    }
  }

  public async updateChunks(chunks: BTreeChunkSignature[]): Promise<void> {
    this.metadata.chunks = chunks;
    await this._atomic_write(
      path.join(this.directory, "metadata.json"),
      JSON.stringify(this.metadata),
    );
  }

  private async _insert(key: string, reference: BTreeReference): Promise<void> {
    const { leaf, index, parents } = await this._find_leaf(key, true);
    if (index < leaf.keys.length && leaf.keys[index] === key) {
      if (this.metadata.unique && leaf.values[index].length > 0) {
        throw new Error(`Duplicate value for unique index: ${this.metadata.field}`);
      }
      leaf.values[index].push(reference);
      this._mark_dirty(leaf);
      return;
    }

    leaf.keys.splice(index, 0, key);
    leaf.values.splice(index, 0, [reference]);
    this._mark_dirty(leaf);
    if (leaf.keys.length <= B_TREE_MAX_KEYS) {
      return;
    }

    const split_at = Math.ceil(leaf.keys.length / 2);
    const right: LeafPage = {
      format: "mongify-btree-page-v1",
      id: this.metadata.nextPageId++,
      leaf: true,
      keys: leaf.keys.splice(split_at),
      values: leaf.values.splice(split_at),
      next: leaf.next,
    };
    leaf.next = right.id;
    this._mark_dirty(leaf);
    this._mark_dirty(right);
    await this._insert_into_parent(leaf.id, right.keys[0], right.id, parents);
  }

  private async _insert_into_parent(
    left_id: number,
    separator: string,
    right_id: number,
    parents: ParentStep[],
  ): Promise<void> {
    const parent_step = parents.pop();
    if (!parent_step) {
      const root: InternalPage = {
        format: "mongify-btree-page-v1",
        id: this.metadata.nextPageId++,
        leaf: false,
        keys: [separator],
        children: [left_id, right_id],
      };
      this.metadata.root = root.id;
      this._mark_dirty(root);
      return;
    }

    const { page: parent, childIndex } = parent_step;
    parent.keys.splice(childIndex, 0, separator);
    parent.children.splice(childIndex + 1, 0, right_id);
    this._mark_dirty(parent);
    if (parent.keys.length <= B_TREE_MAX_KEYS) {
      return;
    }

    const middle = Math.floor(parent.keys.length / 2);
    const promoted = parent.keys[middle];
    const right: InternalPage = {
      format: "mongify-btree-page-v1",
      id: this.metadata.nextPageId++,
      leaf: false,
      keys: parent.keys.splice(middle + 1),
      children: parent.children.splice(middle + 1),
    };
    parent.keys.splice(middle);
    this._mark_dirty(parent);
    this._mark_dirty(right);
    await this._insert_into_parent(parent.id, promoted, right.id, parents);
  }

  private async _remove(key: string, reference: BTreeReference): Promise<void> {
    const { leaf, index } = await this._find_leaf(key, true);
    if (index >= leaf.keys.length || leaf.keys[index] !== key) {
      return;
    }

    const references = leaf.values[index].filter(
      (candidate) =>
        candidate.chunk !== reference.chunk || candidate.id !== reference.id,
    );
    if (references.length > 0) {
      leaf.values[index] = references;
    } else {
      leaf.keys.splice(index, 1);
      leaf.values.splice(index, 1);
    }
    this._mark_dirty(leaf);
  }

  private async _find_leaf(
    key: string,
    for_write = false,
  ): Promise<{ leaf: LeafPage; index: number; parents: ParentStep[] }> {
    const parents: ParentStep[] = [];
    let page = await this._read_page(this.metadata.root, for_write);
    while (!page.leaf) {
      const internal = page as InternalPage;
      const child_index = this._upper_bound(internal.keys, key);
      parents.push({ page: internal, childIndex: child_index });
      page = await this._read_page(internal.children[child_index], for_write);
    }
    return { leaf: page, index: this._lower_bound(page.keys, key), parents };
  }

  private _lower_bound(keys: string[], target: string): number {
    let low = 0;
    let high = keys.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (keys[middle] < target) low = middle + 1;
      else high = middle;
    }
    return low;
  }

  private _upper_bound(keys: string[], target: string): number {
    let low = 0;
    let high = keys.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (keys[middle] <= target) low = middle + 1;
      else high = middle;
    }
    return low;
  }

  private async _read_page(id: number, for_write = false): Promise<BTreePage> {
    const operation_page = this.operation_cache.get(id);
    if (operation_page) {
      return operation_page;
    }

    const page_path = BTreeIndex._page_path(this.directory, id);
    let page = page_cache.get(page_path);
    if (!page) {
      page = JSON.parse(await fs.readFile(page_path, "utf8"));
      this._validate_page(page, id);
      this._cache_page(page_path, page);
    } else {
      page_cache.delete(page_path);
      page_cache.set(page_path, page);
    }

    if (for_write) {
      page = structuredClone(page);
      this.operation_cache.set(id, page);
    }
    return page;
  }

  private _validate_page(page: any, expected_id: number): asserts page is BTreePage {
    const common =
      page?.format === "mongify-btree-page-v1" &&
      page.id === expected_id &&
      Array.isArray(page.keys) &&
      page.keys.every((key: unknown) => typeof key === "string");
    const valid = page?.leaf === true
      ? common && Array.isArray(page.values) && page.values.length === page.keys.length
      : page?.leaf === false &&
        common &&
        Array.isArray(page.children) &&
        page.children.length === page.keys.length + 1;
    if (!valid) {
      throw new Error(`Invalid B-tree page: ${expected_id}`);
    }
  }

  private _begin_operation(): void {
    this.operation_cache = new Map();
    this.dirty_pages = new Set();
  }

  private _mark_dirty(page: BTreePage): void {
    this.operation_cache.set(page.id, page);
    this.dirty_pages.add(page.id);
  }

  private async _commit_operation(): Promise<void> {
    const dirty = Array.from(this.dirty_pages, (id) => ({
      page: this.operation_cache.get(id)!,
      pagePath: BTreeIndex._page_path(this.directory, id),
    }));
    for (let start = 0; start < dirty.length; start += B_TREE_WRITE_CONCURRENCY) {
      const batch = dirty.slice(start, start + B_TREE_WRITE_CONCURRENCY);
      await Promise.all(
        batch.map(({ page, pagePath }) =>
          this._atomic_write(pagePath, JSON.stringify(page)),
        ),
      );
      for (const { page, pagePath } of batch) {
        this._cache_page(pagePath, page);
      }
    }
    await this._atomic_write(
      path.join(this.directory, "metadata.json"),
      JSON.stringify(this.metadata),
    );
    this._end_operation();
  }

  private _end_operation(): void {
    this.operation_cache.clear();
    this.dirty_pages.clear();
  }

  private _cache_page(page_path: string, page: BTreePage): void {
    page_cache.delete(page_path);
    page_cache.set(page_path, page);
    while (page_cache.size > B_TREE_PAGE_CACHE_SIZE) {
      page_cache.delete(page_cache.keys().next().value!);
    }
  }

  private async _atomic_write(file_path: string, data: string): Promise<void> {
    await fs.ensureDir(path.dirname(file_path));
    const temporary_path = path.join(
      path.dirname(file_path),
      `.${path.basename(file_path)}.${process.pid}.${randomUUID()}.tmp`,
    );
    try {
      await fs.writeFile(temporary_path, data, { encoding: "utf8", flag: "wx" });
      await fs.rename(temporary_path, file_path);
    } catch (error) {
      await fs.unlink(temporary_path).catch(() => undefined);
      throw error;
    }
  }

  private static _page_path(directory: string, id: number): string {
    return path.join(directory, "pages", `${String(id).padStart(8, "0")}.json`);
  }
}
