import { randomUUID } from "node:crypto";
import fs from "fs-extra";
import path from "path";
import { CHUNK_SIZE_BYTES } from "./config";
import type {
  CollectionIndex,
  IndexOptions,
  MongifyDocument,
  MongifyQuery,
} from "./types";

interface IndexDefinition {
  unique: boolean;
}

interface CollectionMetadata {
  format: "mongify-chunks-v1";
  generation: string;
  indexes: Record<string, IndexDefinition>;
}

interface IndexReference {
  chunk: string;
  id: string;
}

interface ChunkSignature {
  name: string;
  size: number;
  modified: number;
}

interface PersistedIndex {
  format: "mongify-index-v1";
  field: string;
  generation: string;
  unique: boolean;
  chunks: ChunkSignature[];
  entries: Array<[string, IndexReference[]]>;
}

interface CachedIndex {
  generation: string;
  unique: boolean;
  values: Map<string, IndexReference[]>;
}

interface StoredDocument {
  document: MongifyDocument;
  reference: IndexReference;
}

interface MatchedDocument extends StoredDocument {
  position: number;
}

interface MatchedChunk {
  name: string;
  documents: MongifyDocument[];
  matches: MatchedDocument[];
}

const index_cache = new Map<string, CachedIndex>();

export class Storage {
  constructor(private database_path: string) {}

  public async createCollection(collection_name: string): Promise<void> {
    const existing = await this._read_metadata(collection_name, false);
    if (existing) {
      return;
    }

    const metadata = this._new_metadata();
    await fs.ensureDir(this._chunks_path(collection_name, metadata.generation));
    await fs.ensureDir(this._indexes_path(collection_name));
    await this._write_metadata(collection_name, metadata);
    await this._persist_index(
      collection_name,
      metadata,
      "_id",
      { generation: metadata.generation, unique: true, values: new Map() },
    );
  }

  public async deleteCollection(collection_name: string): Promise<void> {
    await fs.unlink(this._manifest_path(collection_name));
    await fs.remove(this._collection_data_path(collection_name));
    this._clear_collection_cache(collection_name);
  }

  public async readAll(
    collection_name: string,
    create_new = false,
  ): Promise<MongifyDocument[]> {
    const metadata = await this._read_metadata(collection_name, create_new);
    if (!metadata) {
      return [];
    }

    const stored = await this._read_stored_documents(collection_name, metadata);
    return stored.map(({ document }) => document);
  }

  public async replaceAll(
    collection_name: string,
    documents: MongifyDocument[],
  ): Promise<void> {
    const current = await this._read_metadata(collection_name, true);
    const next: CollectionMetadata = {
      ...current!,
      generation: randomUUID(),
    };
    const next_generation_path = this._generation_path(
      collection_name,
      next.generation,
    );
    let committed = false;

    try {
      const stored = await this._write_generation(collection_name, next, documents);
      const indexes = this._build_indexes(next, stored);

      await this._write_metadata(collection_name, next);
      committed = true;
      this._clear_collection_cache(collection_name);

      for (const [field, index] of indexes) {
        index_cache.set(this._cache_key(collection_name, field), index);
        await this._persist_index(collection_name, next, field, index);
      }

      if (current?.generation && current.generation !== next.generation) {
        await fs.remove(this._generation_path(collection_name, current.generation));
      }
    } catch (error) {
      if (!committed) {
        await fs.remove(next_generation_path);
      }
      throw error;
    }
  }

  public async append(
    collection_name: string,
    documents: MongifyDocument[],
  ): Promise<void> {
    if (documents.length === 0) {
      return;
    }

    const metadata = await this._read_metadata(collection_name, true);
    const indexes = new Map<string, CachedIndex>();

    for (const [field] of Object.entries(metadata!.indexes)) {
      indexes.set(field, await this._load_index(collection_name, metadata!, field));
    }

    this._validate_unique_values(metadata!, indexes, documents);
    const stored = await this._append_to_generation(
      collection_name,
      metadata!,
      documents,
    );

    for (const [field, index] of indexes) {
      this._add_to_index(field, index, stored);
      index_cache.set(this._cache_key(collection_name, field), index);
      await this._persist_index(collection_name, metadata!, field, index);
    }
  }

  public async find(
    collection_name: string,
    query?: MongifyQuery,
    limit?: number,
    first = false,
  ): Promise<MongifyDocument[]> {
    const metadata = await this._read_metadata(collection_name, false);
    if (!metadata) {
      return [];
    }

    const query_keys = query ? Object.keys(query) : [];
    if (query_keys.length === 0) {
      return this._scan_chunks(collection_name, metadata, undefined, limit, first);
    }

    const field = query_keys[0];
    const value = query![field];

    if (metadata.indexes[field]) {
      return this._find_with_index(
        collection_name,
        metadata,
        field,
        value,
        limit,
        first,
      );
    }

    return this._scan_chunks(
      collection_name,
      metadata,
      { field, value },
      limit,
      first,
    );
  }

  public async update(
    collection_name: string,
    query: MongifyQuery,
    update: MongifyDocument,
    upsert = false,
  ): Promise<void> {
    const metadata = await this._read_metadata(collection_name, false);
    if (!metadata) {
      if (upsert) {
        const { _id: ignored_id, ...document } = { ...query, ...update };
        await this.append(collection_name, [{ ...document, _id: randomUUID() }]);
      }
      return;
    }

    const matched_chunks = await this._find_matching_chunks(
      collection_name,
      metadata,
      query,
    );
    const matches = Array.from(matched_chunks.values()).flatMap(
      ({ matches }) => matches,
    );

    if (matches.length === 0) {
      if (upsert) {
        const { _id: ignored_id, ...document } = { ...query, ...update };
        await this.append(collection_name, [{ ...document, _id: randomUUID() }]);
      }
      return;
    }

    const indexes = await this._load_all_indexes(collection_name, metadata);
    const replacements = matches.map((match) => ({
      document: { ...match.document, ...update },
      reference: match.reference,
    }));
    this._validate_unique_replacements(indexes, matches, replacements);

    for (const chunk of matched_chunks.values()) {
      for (const match of chunk.matches) {
        chunk.documents[match.position] = { ...match.document, ...update };
      }
      await this._atomic_write(
        path.join(
          this._chunks_path(collection_name, metadata.generation),
          chunk.name,
        ),
        JSON.stringify(chunk.documents),
      );
    }

    await this._replace_index_entries(
      collection_name,
      metadata,
      indexes,
      matches,
      replacements,
    );
  }

  public async delete(
    collection_name: string,
    query: MongifyQuery,
  ): Promise<void> {
    const metadata = await this._read_metadata(collection_name, false);
    if (!metadata) {
      return;
    }

    const matched_chunks = await this._find_matching_chunks(
      collection_name,
      metadata,
      query,
    );
    const matches = Array.from(matched_chunks.values()).flatMap(
      ({ matches }) => matches,
    );
    if (matches.length === 0) {
      return;
    }

    const indexes = await this._load_all_indexes(collection_name, metadata);
    for (const chunk of matched_chunks.values()) {
      const positions = new Set(chunk.matches.map(({ position }) => position));
      const remaining = chunk.documents.filter((_, index) => !positions.has(index));
      await this._atomic_write(
        path.join(
          this._chunks_path(collection_name, metadata.generation),
          chunk.name,
        ),
        JSON.stringify(remaining),
      );
    }

    await this._replace_index_entries(
      collection_name,
      metadata,
      indexes,
      matches,
      [],
    );
  }

  public async createIndex(
    collection_name: string,
    field: string,
    options?: IndexOptions,
  ): Promise<void> {
    this._validate_field(field);
    const metadata = await this._read_metadata(collection_name, true);
    const definition = { unique: options?.unique === true };
    const index = await this._build_index_from_chunks(
      collection_name,
      metadata!,
      field,
      definition.unique,
    );

    await this._persist_index(collection_name, metadata!, field, index);
    metadata!.indexes[field] = definition;
    await this._write_metadata(collection_name, metadata!);
    index_cache.set(this._cache_key(collection_name, field), index);
  }

  public async dropIndex(
    collection_name: string,
    field: string,
  ): Promise<void> {
    if (field === "_id") {
      throw new TypeError("The _id index cannot be dropped");
    }

    const metadata = await this._read_metadata(collection_name, false);
    if (!metadata?.indexes[field]) {
      return;
    }

    delete metadata.indexes[field];
    await this._write_metadata(collection_name, metadata);
    await fs.remove(this._index_path(collection_name, field));
    index_cache.delete(this._cache_key(collection_name, field));
  }

  public async listIndexes(collection_name: string): Promise<CollectionIndex[]> {
    const metadata = await this._read_metadata(collection_name, false);
    if (!metadata) {
      return [];
    }

    return Object.entries(metadata.indexes)
      .map(([field, definition]) => ({ field, unique: definition.unique }))
      .sort((left, right) => left.field.localeCompare(right.field));
  }

  public async totalChunkSize(collection_name: string): Promise<number> {
    const metadata = await this._read_metadata(collection_name, false);
    if (!metadata) {
      return 0;
    }

    const signatures = await this._chunk_signatures(collection_name, metadata);
    return signatures.reduce((total, chunk) => total + chunk.size, 0);
  }

  private _new_metadata(): CollectionMetadata {
    return {
      format: "mongify-chunks-v1",
      generation: randomUUID(),
      indexes: { _id: { unique: true } },
    };
  }

  private async _read_metadata(
    collection_name: string,
    create_new: boolean,
  ): Promise<CollectionMetadata | undefined> {
    const manifest_path = this._manifest_path(collection_name);
    let serialized: string;

    try {
      serialized = await fs.readFile(manifest_path, "utf8");
    } catch (error: any) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
      if (!create_new) {
        return undefined;
      }
      await this.createCollection(collection_name);
      return this._read_metadata(collection_name, false);
    }

    const metadata = JSON.parse(serialized);
    if (
      metadata?.format !== "mongify-chunks-v1" ||
      typeof metadata.generation !== "string" ||
      !metadata.indexes
    ) {
      throw new Error(`Unsupported collection format: ${collection_name}`);
    }

    return metadata;
  }

  private async _write_metadata(
    collection_name: string,
    metadata: CollectionMetadata,
  ): Promise<void> {
    await this._atomic_write(
      this._manifest_path(collection_name),
      JSON.stringify(metadata),
    );
  }

  private async _write_generation(
    collection_name: string,
    metadata: CollectionMetadata,
    documents: MongifyDocument[],
  ): Promise<StoredDocument[]> {
    const chunks_path = this._chunks_path(collection_name, metadata.generation);
    await fs.ensureDir(chunks_path);

    const stored: StoredDocument[] = [];
    let chunk: MongifyDocument[] = [];
    let chunk_bytes = 2;
    let chunk_number = 1;

    const flush = async () => {
      if (chunk.length === 0) {
        return;
      }
      const name = this._chunk_name(chunk_number);
      await this._atomic_write(path.join(chunks_path, name), JSON.stringify(chunk));
      chunk = [];
      chunk_bytes = 2;
      chunk_number += 1;
    };

    for (const document of documents) {
      const serialized = JSON.stringify(document);
      const document_bytes = Buffer.byteLength(serialized);
      const separator_bytes = chunk.length === 0 ? 0 : 1;

      if (
        chunk.length > 0 &&
        chunk_bytes + separator_bytes + document_bytes > CHUNK_SIZE_BYTES
      ) {
        await flush();
      }

      const chunk_name = this._chunk_name(chunk_number);
      chunk.push(document);
      chunk_bytes += (chunk.length === 1 ? 0 : 1) + document_bytes;
      stored.push({
        document,
        reference: { chunk: chunk_name, id: String(document._id) },
      });
    }

    await flush();
    return stored;
  }

  private async _append_to_generation(
    collection_name: string,
    metadata: CollectionMetadata,
    documents: MongifyDocument[],
  ): Promise<StoredDocument[]> {
    const chunks_path = this._chunks_path(collection_name, metadata.generation);
    await fs.ensureDir(chunks_path);
    const chunk_names = await this._list_chunks(collection_name, metadata);
    let chunk_number = chunk_names.length || 1;
    let chunk_name = this._chunk_name(chunk_number);
    let chunk: MongifyDocument[] = [];
    let chunk_bytes = 2;
    let dirty = false;

    if (chunk_names.length > 0) {
      chunk_name = chunk_names.at(-1)!;
      const serialized = await fs.readFile(path.join(chunks_path, chunk_name), "utf8");
      chunk = JSON.parse(serialized);
      chunk_bytes = Buffer.byteLength(serialized);
    }

    const stored: StoredDocument[] = [];
    const flush = async () => {
      if (!dirty) {
        return;
      }
      await this._atomic_write(
        path.join(chunks_path, chunk_name),
        JSON.stringify(chunk),
      );
      dirty = false;
    };

    for (const document of documents) {
      const serialized = JSON.stringify(document);
      const document_bytes = Buffer.byteLength(serialized);
      const separator_bytes = chunk.length === 0 ? 0 : 1;

      if (
        chunk.length > 0 &&
        chunk_bytes + separator_bytes + document_bytes > CHUNK_SIZE_BYTES
      ) {
        await flush();
        chunk_number += 1;
        chunk_name = this._chunk_name(chunk_number);
        chunk = [];
        chunk_bytes = 2;
      }

      chunk.push(document);
      chunk_bytes += (chunk.length === 1 ? 0 : 1) + document_bytes;
      dirty = true;
      stored.push({
        document,
        reference: { chunk: chunk_name, id: String(document._id) },
      });
    }

    await flush();
    return stored;
  }

  private async _find_with_index(
    collection_name: string,
    metadata: CollectionMetadata,
    field: string,
    value: any,
    limit?: number,
    first = false,
  ): Promise<MongifyDocument[]> {
    const index = await this._load_index(collection_name, metadata, field);
    const references = index.values.get(this._index_key(value)) || [];
    const chunk_cache = new Map<string, MongifyDocument[]>();
    const response: MongifyDocument[] = [];

    for (const reference of references) {
      let chunk = chunk_cache.get(reference.chunk);
      if (!chunk) {
        chunk = await this._read_chunk(collection_name, metadata, reference.chunk);
        chunk_cache.set(reference.chunk, chunk);
      }

      const document = chunk.find(
        (candidate) =>
          candidate._id === reference.id && candidate[field] === value,
      );
      if (document) {
        response.push(document);
      }
      if (first || (limit !== undefined && response.length >= limit)) {
        break;
      }
    }

    return response;
  }

  private async _find_matching_chunks(
    collection_name: string,
    metadata: CollectionMetadata,
    query: MongifyQuery,
  ): Promise<Map<string, MatchedChunk>> {
    const field = Object.keys(query)[0];
    const value = query[field];
    const result = new Map<string, MatchedChunk>();

    if (metadata.indexes[field]) {
      const index = await this._load_index(collection_name, metadata, field);
      const references = index.values.get(this._index_key(value)) || [];
      const grouped = new Map<string, IndexReference[]>();
      for (const reference of references) {
        const group = grouped.get(reference.chunk) || [];
        group.push(reference);
        grouped.set(reference.chunk, group);
      }

      for (const [chunk_name, chunk_references] of grouped) {
        const documents = await this._read_chunk(
          collection_name,
          metadata,
          chunk_name,
        );
        const reference_ids = new Set(chunk_references.map(({ id }) => id));
        const matches: MatchedDocument[] = [];
        documents.forEach((document, position) => {
          if (
            reference_ids.has(String(document._id)) &&
            document[field] === value
          ) {
            matches.push({
              document,
              position,
              reference: { chunk: chunk_name, id: String(document._id) },
            });
          }
        });
        if (matches.length > 0) {
          result.set(chunk_name, { name: chunk_name, documents, matches });
        }
      }
      return result;
    }

    for (const chunk_name of await this._list_chunks(collection_name, metadata)) {
      const documents = await this._read_chunk(
        collection_name,
        metadata,
        chunk_name,
      );
      const matches: MatchedDocument[] = [];
      documents.forEach((document, position) => {
        if (document[field] === value) {
          matches.push({
            document,
            position,
            reference: { chunk: chunk_name, id: String(document._id) },
          });
        }
      });
      if (matches.length > 0) {
        result.set(chunk_name, { name: chunk_name, documents, matches });
      }
    }
    return result;
  }

  private async _scan_chunks(
    collection_name: string,
    metadata: CollectionMetadata,
    query?: { field: string; value: any },
    limit?: number,
    first = false,
  ): Promise<MongifyDocument[]> {
    const response: MongifyDocument[] = [];
    const chunk_names = await this._list_chunks(collection_name, metadata);

    for (const chunk_name of chunk_names) {
      const chunk = await this._read_chunk(collection_name, metadata, chunk_name);
      for (const document of chunk) {
        if (!query || document[query.field] === query.value) {
          response.push(document);
          if (first || (limit !== undefined && response.length >= limit)) {
            return response;
          }
        }
      }
    }

    return response;
  }

  private async _load_index(
    collection_name: string,
    metadata: CollectionMetadata,
    field: string,
  ): Promise<CachedIndex> {
    const cache_key = this._cache_key(collection_name, field);
    const cached = index_cache.get(cache_key);
    if (cached?.generation === metadata.generation) {
      return cached;
    }

    try {
      const serialized = await fs.readFile(
        this._index_path(collection_name, field),
        "utf8",
      );
      const persisted: PersistedIndex = JSON.parse(serialized);
      const signatures = await this._chunk_signatures(collection_name, metadata);

      if (
        persisted.format === "mongify-index-v1" &&
        persisted.generation === metadata.generation &&
        persisted.field === field &&
        JSON.stringify(persisted.chunks) === JSON.stringify(signatures)
      ) {
        const index = {
          generation: persisted.generation,
          unique: persisted.unique,
          values: new Map(persisted.entries),
        };
        index_cache.set(cache_key, index);
        return index;
      }
    } catch {}

    const index = await this._build_index_from_chunks(
      collection_name,
      metadata,
      field,
      metadata.indexes[field].unique,
    );
    index_cache.set(cache_key, index);
    await this._persist_index(collection_name, metadata, field, index);
    return index;
  }

  private async _build_index_from_chunks(
    collection_name: string,
    metadata: CollectionMetadata,
    field: string,
    unique: boolean,
  ): Promise<CachedIndex> {
    const index: CachedIndex = {
      generation: metadata.generation,
      unique,
      values: new Map(),
    };

    for (const chunk_name of await this._list_chunks(collection_name, metadata)) {
      const documents = await this._read_chunk(
        collection_name,
        metadata,
        chunk_name,
      );
      this._add_to_index(
        field,
        index,
        documents.map((document) => ({
          document,
          reference: { chunk: chunk_name, id: String(document._id) },
        })),
      );
    }

    return index;
  }

  private async _load_all_indexes(
    collection_name: string,
    metadata: CollectionMetadata,
  ): Promise<Map<string, CachedIndex>> {
    const indexes = new Map<string, CachedIndex>();
    for (const field of Object.keys(metadata.indexes)) {
      indexes.set(
        field,
        await this._load_index(collection_name, metadata, field),
      );
    }
    return indexes;
  }

  private _validate_unique_replacements(
    indexes: Map<string, CachedIndex>,
    previous: StoredDocument[],
    replacements: StoredDocument[],
  ): void {
    const affected = new Set(
      previous.map(({ reference }) => `${reference.chunk}\0${reference.id}`),
    );

    for (const [field, index] of indexes) {
      if (!index.unique) {
        continue;
      }
      const pending = new Set<string>();
      for (const replacement of replacements) {
        if (!Object.prototype.hasOwnProperty.call(replacement.document, field)) {
          continue;
        }
        const key = this._index_key(replacement.document[field]);
        const has_unaffected = (index.values.get(key) || []).some(
          (reference) => !affected.has(`${reference.chunk}\0${reference.id}`),
        );
        if (has_unaffected || pending.has(key)) {
          throw new Error(`Duplicate value for unique index: ${field}`);
        }
        pending.add(key);
      }
    }
  }

  private async _replace_index_entries(
    collection_name: string,
    metadata: CollectionMetadata,
    indexes: Map<string, CachedIndex>,
    previous: StoredDocument[],
    replacements: StoredDocument[],
  ): Promise<void> {
    for (const [field, index] of indexes) {
      for (const entry of previous) {
        if (!Object.prototype.hasOwnProperty.call(entry.document, field)) {
          continue;
        }
        const key = this._index_key(entry.document[field]);
        const remaining = (index.values.get(key) || []).filter(
          (reference) =>
            reference.chunk !== entry.reference.chunk ||
            reference.id !== entry.reference.id,
        );
        if (remaining.length > 0) {
          index.values.set(key, remaining);
        } else {
          index.values.delete(key);
        }
      }

      this._add_to_index(field, index, replacements);
      index_cache.set(this._cache_key(collection_name, field), index);
      await this._persist_index(collection_name, metadata, field, index);
    }
  }

  private _build_indexes(
    metadata: CollectionMetadata,
    stored: StoredDocument[],
  ): Map<string, CachedIndex> {
    return new Map(
      Object.entries(metadata.indexes).map(([field, definition]) => [
        field,
        this._build_index(field, definition.unique, metadata, stored),
      ]),
    );
  }

  private _build_index(
    field: string,
    unique: boolean,
    metadata: CollectionMetadata,
    stored: StoredDocument[],
  ): CachedIndex {
    const index: CachedIndex = {
      generation: metadata.generation,
      unique,
      values: new Map(),
    };
    this._add_to_index(field, index, stored);
    return index;
  }

  private _add_to_index(
    field: string,
    index: CachedIndex,
    stored: StoredDocument[],
  ): void {
    for (const entry of stored) {
      if (!Object.prototype.hasOwnProperty.call(entry.document, field)) {
        continue;
      }
      const key = this._index_key(entry.document[field]);
      const references = index.values.get(key) || [];
      if (index.unique && references.length > 0) {
        throw new Error(`Duplicate value for unique index: ${field}`);
      }
      references.push(entry.reference);
      index.values.set(key, references);
    }
  }

  private _validate_unique_values(
    metadata: CollectionMetadata,
    indexes: Map<string, CachedIndex>,
    documents: MongifyDocument[],
  ): void {
    for (const [field, definition] of Object.entries(metadata.indexes)) {
      if (!definition.unique) {
        continue;
      }
      const existing = indexes.get(field)!;
      const pending = new Set<string>();
      for (const document of documents) {
        if (!Object.prototype.hasOwnProperty.call(document, field)) {
          continue;
        }
        const key = this._index_key(document[field]);
        if (existing.values.has(key) || pending.has(key)) {
          throw new Error(`Duplicate value for unique index: ${field}`);
        }
        pending.add(key);
      }
    }
  }

  private async _persist_index(
    collection_name: string,
    metadata: CollectionMetadata,
    field: string,
    index: CachedIndex,
  ): Promise<void> {
    await fs.ensureDir(this._indexes_path(collection_name));
    const persisted: PersistedIndex = {
      format: "mongify-index-v1",
      field,
      generation: metadata.generation,
      unique: index.unique,
      chunks: await this._chunk_signatures(collection_name, metadata),
      entries: Array.from(index.values.entries()),
    };
    await this._atomic_write(
      this._index_path(collection_name, field),
      JSON.stringify(persisted),
    );
  }

  private async _read_stored_documents(
    collection_name: string,
    metadata: CollectionMetadata,
  ): Promise<StoredDocument[]> {
    const stored: StoredDocument[] = [];
    for (const chunk_name of await this._list_chunks(collection_name, metadata)) {
      const chunk = await this._read_chunk(collection_name, metadata, chunk_name);
      for (const document of chunk) {
        stored.push({
          document,
          reference: { chunk: chunk_name, id: String(document._id) },
        });
      }
    }
    return stored;
  }

  private async _read_chunk(
    collection_name: string,
    metadata: CollectionMetadata,
    chunk_name: string,
  ): Promise<MongifyDocument[]> {
    const serialized = await fs.readFile(
      path.join(this._chunks_path(collection_name, metadata.generation), chunk_name),
      "utf8",
    );
    const chunk = JSON.parse(serialized);
    if (!Array.isArray(chunk)) {
      throw new Error(`Invalid chunk format: ${chunk_name}`);
    }
    return chunk;
  }

  private async _list_chunks(
    collection_name: string,
    metadata: CollectionMetadata,
  ): Promise<string[]> {
    const chunks_path = this._chunks_path(collection_name, metadata.generation);
    await fs.ensureDir(chunks_path);
    return (await fs.readdir(chunks_path))
      .filter((name) => /^\d{6}\.json$/.test(name))
      .sort();
  }

  private async _chunk_signatures(
    collection_name: string,
    metadata: CollectionMetadata,
  ): Promise<ChunkSignature[]> {
    const chunks_path = this._chunks_path(collection_name, metadata.generation);
    const signatures: ChunkSignature[] = [];
    for (const name of await this._list_chunks(collection_name, metadata)) {
      const stats = await fs.stat(path.join(chunks_path, name));
      signatures.push({
        name,
        size: stats.size,
        modified: Math.trunc(stats.mtimeMs),
      });
    }
    return signatures;
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

  private _index_key(value: any): string {
    return `${typeof value}:${JSON.stringify(value)}`;
  }

  private _validate_field(field: unknown): asserts field is string {
    if (typeof field !== "string" || field.trim() === "" || field.includes("\0")) {
      throw new TypeError("Index field must be a non-empty string");
    }
  }

  private _chunk_name(number: number): string {
    return `${String(number).padStart(6, "0")}.json`;
  }

  private _manifest_path(collection_name: string): string {
    return path.join(this.database_path, `${collection_name}.json`);
  }

  private _collection_data_path(collection_name: string): string {
    return path.join(
      this.database_path,
      ".mongify",
      Buffer.from(collection_name).toString("base64url"),
    );
  }

  private _generation_path(collection_name: string, generation: string): string {
    return path.join(
      this._collection_data_path(collection_name),
      "generations",
      generation,
    );
  }

  private _chunks_path(collection_name: string, generation: string): string {
    return path.join(this._generation_path(collection_name, generation), "chunks");
  }

  private _indexes_path(collection_name: string): string {
    return path.join(this._collection_data_path(collection_name), "indexes");
  }

  private _index_path(collection_name: string, field: string): string {
    return path.join(
      this._indexes_path(collection_name),
      `${Buffer.from(field).toString("base64url")}.json`,
    );
  }

  private _cache_key(collection_name: string, field: string): string {
    return `${this._manifest_path(collection_name)}\0${field}`;
  }

  private _clear_collection_cache(collection_name: string): void {
    const prefix = `${this._manifest_path(collection_name)}\0`;
    for (const key of index_cache.keys()) {
      if (key.startsWith(prefix)) {
        index_cache.delete(key);
      }
    }
  }
}
