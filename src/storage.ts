import { randomUUID } from "node:crypto";
import { open } from "node:fs/promises";
import fs from "fs-extra";
import path from "path";
import {
  BTreeIndex,
  type BTreeReference,
} from "./btree-index";
import { CHUNK_SIZE_BYTES } from "./config";
import { JournalTransaction } from "./journal";
import {
  getSimpleRangeQuery,
  getSimpleEqualityQuery,
  matchesQuery,
  projectDocument,
  type SimpleRangeQuery,
} from "./query";
import type {
  CollectionIndex,
  CreateIndexResult,
  IndexOptions,
  IndexFields,
  MongifyDocument,
  MongifyQuery,
} from "./types";

interface IndexDefinition {
  fields: string[];
  unique: boolean;
}

interface CollectionMetadata {
  format: "mongify-chunks-v1";
  generation: string;
  revision: number;
  indexes: Record<string, IndexDefinition>;
}

type IndexReference = BTreeReference;
interface ChunkSignature {
  name: string;
  size: number;
  modified: number;
}

interface CachedIndex {
  generation: string;
  revision: number;
  tree: BTreeIndex;
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

interface SerializedDate {
  path: string[];
  value: number;
}

interface PreparedDocument {
  serialized: string;
  dates: SerializedDate[];
}

interface PreparedChunk {
  serialized: string;
  bytes: number;
  dateCount: number;
  locations: Array<{
    offset: number;
    length: number;
    dates: Array<[string[], number]>;
  }>;
}

const CHUNK_FORMAT = "mongify-chunk-v1";
const EMPTY_CHUNK_BYTES = Buffer.byteLength(
  `{"format":"${CHUNK_FORMAT}","documents":[],"dates":[]}`,
);

const index_cache = new Map<string, CachedIndex>();

export class Storage {
  constructor(private database_path: string) {}

  public async transaction<T>(collection_name: string, operation: () => Promise<T>): Promise<T> {
    return JournalTransaction.run(this.database_path, collection_name, operation);
  }

  public async recover(collection_name: string): Promise<void> {
    await JournalTransaction.recover(this.database_path, collection_name);
  }

  public async createCollection(collection_name: string): Promise<void> {
    const existing = await this._read_metadata(collection_name, false);
    if (existing) {
      return;
    }

    const metadata = this._new_metadata();
    await fs.ensureDir(this._chunks_path(collection_name, metadata.generation));
    await fs.ensureDir(this._indexes_path(collection_name));
    await this._write_metadata(collection_name, metadata);
    const id_index = this._index_name(["_id"]);
    await BTreeIndex.build(
      this._index_path(collection_name, id_index),
      {
        field: id_index,
        generation: metadata.generation,
        unique: true,
        revision: metadata.revision,
        entries: new Map(),
      },
    );
  }

  public async deleteCollection(collection_name: string): Promise<void> {
    await JournalTransaction.beforeWrite(this._manifest_path(collection_name));
    await JournalTransaction.beforeWrite(this._collection_data_path(collection_name));
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
      revision: current!.revision + 1,
    };
    const next_generation_path = this._generation_path(
      collection_name,
      next.generation,
    );
    let committed = false;

    try {
      const stored = await this._write_generation(collection_name, next, documents);
      const indexes = await this._build_indexes(collection_name, next, stored);

      await this._write_metadata(collection_name, next);
      committed = true;
      this._clear_collection_cache(collection_name);

      for (const [index_name, tree] of indexes) {
        index_cache.set(this._cache_key(collection_name, index_name), {
          generation: next.generation,
          revision: next.revision,
          tree,
        });
      }

      if (current?.generation && current.generation !== next.generation) {
        const previous_generation = this._generation_path(
          collection_name,
          current.generation,
        );
        await JournalTransaction.beforeWrite(previous_generation);
        await fs.remove(previous_generation);
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
    const indexes = new Map<string, BTreeIndex>();

    for (const [index_name] of Object.entries(metadata!.indexes)) {
      indexes.set(
        index_name,
        await this._load_index(collection_name, metadata!, index_name),
      );
    }

    await this._validate_unique_values(metadata!, indexes, documents);
    const stored = await this._append_to_generation(
      collection_name,
      metadata!,
      documents,
    );

    const next_revision = metadata!.revision + 1;
    for (const [index_name, tree] of indexes) {
      const definition = metadata!.indexes[index_name];
      await tree.insertMany(
        this._tree_entries(definition.fields, stored),
        next_revision,
      );
      index_cache.set(this._cache_key(collection_name, index_name), {
        generation: metadata!.generation,
        revision: next_revision,
        tree,
      });
    }
    metadata!.revision = next_revision;
    await this._write_metadata(collection_name, metadata!);
  }

  public async find(
    collection_name: string,
    query?: MongifyQuery,
    limit?: number,
    first = false,
    projection?: Record<string, 0 | 1 | boolean>,
    skip = 0,
    sort?: Record<string, 1 | -1>,
  ): Promise<MongifyDocument[]> {
    if (limit === 0) {
      return [];
    }
    if (sort !== undefined) {
      this._validate_sort(sort);
      const matches = await this.find(
        collection_name,
        query,
        undefined,
        false,
        undefined,
        0,
      );
      const sorted = this._sort_documents(matches, sort).slice(
        skip,
        limit === undefined ? undefined : skip + limit,
      );
      return sorted.map((document) => projectDocument(document, projection));
    }
    const metadata = await this._read_metadata(collection_name, false);
    if (!metadata) {
      return [];
    }

    const equality_index = this._find_equality_index(metadata, query);
    if (equality_index) {
        return this._find_with_index(
          collection_name,
          metadata,
          query!,
          equality_index,
          limit,
          first,
          projection,
          skip,
        );
    }

    const range = getSimpleRangeQuery(query);
    const range_index = range
      ? this._find_single_field_index(metadata, range.field)
      : undefined;
    if (range && range_index) {
      return this._find_with_range_index(
        collection_name,
        metadata,
        query!,
        range,
        range_index,
        limit,
        first,
        projection,
        skip,
      );
    }

    return this._scan_chunks(
      collection_name,
      metadata,
      query,
      limit,
      first,
      projection,
      skip,
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
    await this._validate_unique_replacements(
      metadata,
      indexes,
      matches,
      replacements,
    );

    const previous_chunk_documents: StoredDocument[] = [];
    const next_chunk_documents: StoredDocument[] = [];
    for (const chunk of matched_chunks.values()) {
      previous_chunk_documents.push(
        ...chunk.documents.map((document) => ({
          document,
          reference: { chunk: chunk.name, id: String(document._id) },
        })),
      );
      for (const match of chunk.matches) {
        chunk.documents[match.position] = { ...match.document, ...update };
      }
      const prepared = this._prepare_chunk(chunk.documents);
      await this._atomic_write(
        path.join(
          this._chunks_path(collection_name, metadata.generation),
          chunk.name,
        ),
        prepared.serialized,
      );
      next_chunk_documents.push(
        ...this._stored_documents_for_chunk(
          chunk.name,
          chunk.documents,
          prepared,
        ),
      );
    }

    await this._replace_index_entries(
      collection_name,
      metadata,
      indexes,
      previous_chunk_documents,
      next_chunk_documents,
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
    const previous_chunk_documents: StoredDocument[] = [];
    const next_chunk_documents: StoredDocument[] = [];
    for (const chunk of matched_chunks.values()) {
      previous_chunk_documents.push(
        ...chunk.documents.map((document) => ({
          document,
          reference: { chunk: chunk.name, id: String(document._id) },
        })),
      );
      const positions = new Set(chunk.matches.map(({ position }) => position));
      const remaining = chunk.documents.filter((_, index) => !positions.has(index));
      const prepared = this._prepare_chunk(remaining);
      await this._atomic_write(
        path.join(
          this._chunks_path(collection_name, metadata.generation),
          chunk.name,
        ),
        prepared.serialized,
      );
      next_chunk_documents.push(
        ...this._stored_documents_for_chunk(chunk.name, remaining, prepared),
      );
    }

    await this._replace_index_entries(
      collection_name,
      metadata,
      indexes,
      previous_chunk_documents,
      next_chunk_documents,
    );
  }

  public async createIndex(
    collection_name: string,
    field: IndexFields,
    options?: IndexOptions,
  ): Promise<CreateIndexResult> {
    const fields = this._normalize_index_fields(field);
    const index_name = this._index_name(fields);
    const metadata = await this._read_metadata(collection_name, true);
    const indexesBefore = Object.keys(metadata!.indexes).length;

    if (metadata!.indexes[index_name]) {
      return {
        acknowledge: false,
        indexesBefore,
        indexesAfter: indexesBefore,
        error: "exists",
      };
    }

    const definition: IndexDefinition = {
      fields,
      unique: options?.unique === true,
    };
    const index = await this._build_index_from_chunks(
      collection_name,
      metadata!,
      index_name,
      definition,
    );

    metadata!.indexes[index_name] = definition;
    await this._write_metadata(collection_name, metadata!);
    index_cache.set(this._cache_key(collection_name, index_name), {
      generation: metadata!.generation,
      revision: metadata!.revision,
      tree: index,
    });
    return {
      acknowledge: true,
      indexesBefore,
      indexesAfter: indexesBefore + 1,
    };
  }

  public async dropIndex(
    collection_name: string,
    field: IndexFields,
  ): Promise<void> {
    const fields = this._normalize_index_fields(field);
    const index_name = this._index_name(fields);
    if (fields.length === 1 && fields[0] === "_id") {
      throw new TypeError("The _id index cannot be dropped");
    }

    const metadata = await this._read_metadata(collection_name, false);
    if (!metadata?.indexes[index_name]) {
      return;
    }

    delete metadata.indexes[index_name];
    await this._write_metadata(collection_name, metadata);
    await JournalTransaction.beforeWrite(
      this._index_path(collection_name, index_name),
    );
    await fs.remove(this._index_path(collection_name, index_name));
    BTreeIndex.clearCache(this._index_path(collection_name, index_name));
    index_cache.delete(this._cache_key(collection_name, index_name));
  }

  public async listIndexes(collection_name: string): Promise<CollectionIndex[]> {
    const metadata = await this._read_metadata(collection_name, false);
    if (!metadata) {
      return [];
    }

    return Object.entries(metadata.indexes)
      .map(([, definition]) => ({
        field:
          definition.fields.length === 1
            ? definition.fields[0]
            : [...definition.fields],
        unique: definition.unique,
      }))
      .sort((left, right) =>
        JSON.stringify(left.field).localeCompare(JSON.stringify(right.field)),
      );
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
      revision: 0,
      indexes: { _id: { fields: ["_id"], unique: true } },
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
      !Number.isSafeInteger(metadata.revision) ||
      metadata.revision < 0 ||
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
    let prepared_documents: PreparedDocument[] = [];
    let chunk_bytes = EMPTY_CHUNK_BYTES;
    let chunk_date_count = 0;
    let chunk_number = 1;

    const flush = async () => {
      if (chunk.length === 0) {
        return;
      }
      const name = this._chunk_name(chunk_number);
      const prepared_chunk = this._prepare_serialized_chunk(prepared_documents);
      await this._atomic_write(
        path.join(chunks_path, name),
        prepared_chunk.serialized,
      );
      stored.push(...this._stored_documents_for_chunk(name, chunk, prepared_chunk));
      chunk = [];
      prepared_documents = [];
      chunk_bytes = EMPTY_CHUNK_BYTES;
      chunk_date_count = 0;
      chunk_number += 1;
    };

    for (const document of documents) {
      const prepared = this._serialize_document(document);
      const additional_bytes = this._document_chunk_bytes(
        prepared,
        chunk.length,
        chunk_date_count,
      );

      if (
        chunk.length > 0 &&
        chunk_bytes + additional_bytes > CHUNK_SIZE_BYTES
      ) {
        await flush();
      }

      chunk.push(document);
      prepared_documents.push(prepared);
      chunk_bytes += this._document_chunk_bytes(
        prepared,
        chunk.length - 1,
        chunk_date_count,
      );
      chunk_date_count += prepared.dates.length;
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
    let prepared_documents: PreparedDocument[] = [];
    let chunk_bytes = EMPTY_CHUNK_BYTES;
    let chunk_date_count = 0;
    let dirty = false;

    if (chunk_names.length > 0) {
      chunk_name = chunk_names.at(-1)!;
      chunk = await this._read_chunk(collection_name, metadata, chunk_name);
      prepared_documents = chunk.map((document) =>
        this._serialize_document(document),
      );
      const prepared = this._prepare_serialized_chunk(prepared_documents);
      chunk_bytes = prepared.bytes;
      chunk_date_count = prepared.dateCount;
    }

    const stored: StoredDocument[] = [];
    const inserted_ids = new Set(documents.map(({ _id }) => String(_id)));
    const flush = async () => {
      if (!dirty) {
        return;
      }
      const prepared_chunk = this._prepare_serialized_chunk(prepared_documents);
      await this._atomic_write(
        path.join(chunks_path, chunk_name),
        prepared_chunk.serialized,
      );
      stored.push(
        ...this._stored_documents_for_chunk(
          chunk_name,
          chunk,
          prepared_chunk,
        ).filter(({ reference }) => inserted_ids.has(reference.id)),
      );
      dirty = false;
    };

    for (const document of documents) {
      const prepared = this._serialize_document(document);
      const additional_bytes = this._document_chunk_bytes(
        prepared,
        chunk.length,
        chunk_date_count,
      );

      if (
        chunk.length > 0 &&
        chunk_bytes + additional_bytes > CHUNK_SIZE_BYTES
      ) {
        await flush();
        chunk_number += 1;
        chunk_name = this._chunk_name(chunk_number);
        chunk = [];
        prepared_documents = [];
        chunk_bytes = EMPTY_CHUNK_BYTES;
        chunk_date_count = 0;
      }

      chunk.push(document);
      prepared_documents.push(prepared);
      chunk_bytes += this._document_chunk_bytes(
        prepared,
        chunk.length - 1,
        chunk_date_count,
      );
      chunk_date_count += prepared.dates.length;
      dirty = true;
    }

    await flush();
    return stored;
  }

  private async _find_with_index(
    collection_name: string,
    metadata: CollectionMetadata,
    query: MongifyQuery,
    index_name: string,
    limit?: number,
    first = false,
    projection?: Record<string, 0 | 1 | boolean>,
    skip = 0,
  ): Promise<MongifyDocument[]> {
    const references = await this._index_references(
      collection_name,
      metadata,
      index_name,
      query,
    );
    const response: MongifyDocument[] = [];
    let matched = 0;

    for (const reference of references) {
      const document = await this._read_indexed_document(
        collection_name,
        metadata,
        reference,
      );
      if (document && matchesQuery(document, query)) {
        if (matched < skip) {
          matched += 1;
          continue;
        }
        response.push(projectDocument(document, projection));
      }
      if (first || (limit !== undefined && response.length >= limit)) {
        break;
      }
    }

    return response;
  }

  private async _find_with_range_index(
    collection_name: string,
    metadata: CollectionMetadata,
    query: MongifyQuery,
    range: SimpleRangeQuery,
    index_name: string,
    limit?: number,
    first = false,
    projection?: Record<string, 0 | 1 | boolean>,
    skip = 0,
  ): Promise<MongifyDocument[]> {
    const references = await this._range_index_references(
      collection_name,
      metadata,
      range,
      index_name,
    );
    const response: MongifyDocument[] = [];
    let matched = 0;

    for (const reference of references) {
      const document = await this._read_indexed_document(
        collection_name,
        metadata,
        reference,
      );
      if (!document || !matchesQuery(document, query)) continue;
      if (matched < skip) {
        matched += 1;
        continue;
      }
      response.push(projectDocument(document, projection));
      if (first || (limit !== undefined && response.length >= limit)) break;
    }
    return response;
  }

  private async _find_matching_chunks(
    collection_name: string,
    metadata: CollectionMetadata,
    query: MongifyQuery,
  ): Promise<Map<string, MatchedChunk>> {
    const result = new Map<string, MatchedChunk>();

    const equality_index = this._find_equality_index(metadata, query);
    if (equality_index) {
      const references = await this._index_references(
        collection_name,
        metadata,
        equality_index,
        query,
      );
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
            matchesQuery(document, query)
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

    const range = getSimpleRangeQuery(query);
    const range_index = range
      ? this._find_single_field_index(metadata, range.field)
      : undefined;
    if (range && range_index) {
      const references = await this._range_index_references(
        collection_name,
        metadata,
        range,
        range_index,
      );
      const grouped = new Map<string, Set<string>>();
      for (const reference of references) {
        const ids = grouped.get(reference.chunk) || new Set<string>();
        ids.add(reference.id);
        grouped.set(reference.chunk, ids);
      }
      for (const [chunk_name, reference_ids] of grouped) {
        const documents = await this._read_chunk(
          collection_name,
          metadata,
          chunk_name,
        );
        const matches: MatchedDocument[] = [];
        documents.forEach((document, position) => {
          if (
            reference_ids.has(String(document._id)) &&
            matchesQuery(document, query)
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

    return this._scan_matching_chunks(collection_name, metadata, query);
  }

  private async _scan_matching_chunks(
    collection_name: string,
    metadata: CollectionMetadata,
    query: MongifyQuery,
  ): Promise<Map<string, MatchedChunk>> {
    const result = new Map<string, MatchedChunk>();
    for (const chunk_name of await this._list_chunks(collection_name, metadata)) {
      const documents = await this._read_chunk(
        collection_name,
        metadata,
        chunk_name,
      );
      const matches: MatchedDocument[] = [];
      documents.forEach((document, position) => {
        if (matchesQuery(document, query)) {
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
    query?: MongifyQuery,
    limit?: number,
    first = false,
    projection?: Record<string, 0 | 1 | boolean>,
    skip = 0,
  ): Promise<MongifyDocument[]> {
    const response: MongifyDocument[] = [];
    let matched = 0;
    const chunk_names = await this._list_chunks(collection_name, metadata);

    for (const chunk_name of chunk_names) {
      const chunk = await this._read_chunk(collection_name, metadata, chunk_name);
      for (const document of chunk) {
        if (matchesQuery(document, query)) {
          if (matched < skip) {
            matched += 1;
            continue;
          }
          response.push(projectDocument(document, projection));
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
    index_name: string,
  ): Promise<BTreeIndex> {
    const cache_key = this._cache_key(collection_name, index_name);
    const cached = index_cache.get(cache_key);
    if (
      cached?.generation === metadata.generation &&
      cached.revision === metadata.revision
    ) {
      return cached.tree;
    }

    try {
      const tree = await BTreeIndex.open(this._index_path(collection_name, index_name), {
        field: index_name,
        generation: metadata.generation,
        unique: metadata.indexes[index_name].unique,
        revision: metadata.revision,
      });
      index_cache.set(cache_key, {
        generation: metadata.generation,
        revision: metadata.revision,
        tree,
      });
      return tree;
    } catch {}

    const tree = await this._build_index_from_chunks(
      collection_name,
      metadata,
      index_name,
      metadata.indexes[index_name],
    );
    index_cache.set(cache_key, {
      generation: metadata.generation,
      revision: metadata.revision,
      tree,
    });
    return tree;
  }

  private async _index_references(
    collection_name: string,
    metadata: CollectionMetadata,
    index_name: string,
    query: MongifyQuery,
  ): Promise<IndexReference[]> {
    const definition = metadata.indexes[index_name];
    const key = this._compound_index_key(definition.fields, query);
    if (key === undefined) return [];
    try {
      const tree = await this._load_index(collection_name, metadata, index_name);
      return await tree.search(key);
    } catch {
      const directory = this._index_path(collection_name, index_name);
      index_cache.delete(this._cache_key(collection_name, index_name));
      BTreeIndex.clearCache(directory);
      const tree = await this._build_index_from_chunks(
        collection_name,
        metadata,
        index_name,
        definition,
      );
      index_cache.set(this._cache_key(collection_name, index_name), {
        generation: metadata.generation,
        revision: metadata.revision,
        tree,
      });
      return tree.search(key);
    }
  }

  private async _range_index_references(
    collection_name: string,
    metadata: CollectionMetadata,
    range: SimpleRangeQuery,
    index_name: string,
  ): Promise<IndexReference[]> {
    const bounds = {
      lower:
        range.lower === undefined
          ? undefined
          : this._index_key(range.lower.value),
      lowerInclusive: range.lower?.inclusive,
      upper:
        range.upper === undefined
          ? undefined
          : this._index_key(range.upper.value),
      upperInclusive: range.upper?.inclusive,
    };
    try {
      const tree = await this._load_index(
        collection_name,
        metadata,
        index_name,
      );
      return await tree.range(bounds);
    } catch {
      const directory = this._index_path(collection_name, index_name);
      index_cache.delete(this._cache_key(collection_name, index_name));
      BTreeIndex.clearCache(directory);
      const tree = await this._build_index_from_chunks(
        collection_name,
        metadata,
        index_name,
        metadata.indexes[index_name],
      );
      index_cache.set(this._cache_key(collection_name, index_name), {
        generation: metadata.generation,
        revision: metadata.revision,
        tree,
      });
      return tree.range(bounds);
    }
  }

  private async _build_index_from_chunks(
    collection_name: string,
    metadata: CollectionMetadata,
    index_name: string,
    definition: IndexDefinition,
  ): Promise<BTreeIndex> {
    const entries = new Map<string, IndexReference[]>();

    for (const chunk_name of await this._list_chunks(collection_name, metadata)) {
      const stored_documents = await this._read_stored_chunk(
        collection_name,
        metadata,
        chunk_name,
      );
      for (const { document, reference } of stored_documents) {
        const key = this._compound_index_key(definition.fields, document);
        if (key === undefined) continue;
        const references = entries.get(key) || [];
        references.push(reference);
        if (definition.unique && references.length > 1) {
          throw new Error(
            `Duplicate value for unique index: ${definition.fields.join(", ")}`,
          );
        }
        entries.set(key, references);
      }
    }

    return BTreeIndex.build(this._index_path(collection_name, index_name), {
      field: index_name,
      generation: metadata.generation,
      unique: definition.unique,
      revision: metadata.revision,
      entries,
    });
  }

  private async _load_all_indexes(
    collection_name: string,
    metadata: CollectionMetadata,
  ): Promise<Map<string, BTreeIndex>> {
    const indexes = new Map<string, BTreeIndex>();
    for (const index_name of Object.keys(metadata.indexes)) {
      indexes.set(
        index_name,
        await this._load_index(collection_name, metadata, index_name),
      );
    }
    return indexes;
  }

  private _validate_unique_replacements(
    metadata: CollectionMetadata,
    indexes: Map<string, BTreeIndex>,
    previous: StoredDocument[],
    replacements: StoredDocument[],
  ): Promise<void> {
    const affected = new Set(
      previous.map(({ reference }) => `${reference.chunk}\0${reference.id}`),
    );

    return (async () => {
      for (const [index_name, tree] of indexes) {
        if (!tree.unique) continue;
        const definition = metadata.indexes[index_name];
        const pending = new Set<string>();
        for (const replacement of replacements) {
          const key = this._compound_index_key(
            definition.fields,
            replacement.document,
          );
          if (key === undefined) continue;
          const existing = await tree.search(key);
          const has_unaffected = existing.some(
            (reference) => !affected.has(`${reference.chunk}\0${reference.id}`),
          );
          if (has_unaffected || pending.has(key)) {
            throw new Error(
              `Duplicate value for unique index: ${definition.fields.join(", ")}`,
            );
          }
          pending.add(key);
        }
      }
    })();
  }

  private async _replace_index_entries(
    collection_name: string,
    metadata: CollectionMetadata,
    indexes: Map<string, BTreeIndex>,
    previous: StoredDocument[],
    replacements: StoredDocument[],
  ): Promise<void> {
    const next_revision = metadata.revision + 1;
    for (const [index_name, tree] of indexes) {
      const definition = metadata.indexes[index_name];
      await tree.replaceReferences(
        this._tree_entries(definition.fields, previous),
        this._tree_entries(definition.fields, replacements),
        next_revision,
      );
      index_cache.set(this._cache_key(collection_name, index_name), {
        generation: metadata.generation,
        revision: next_revision,
        tree,
      });
    }
    metadata.revision = next_revision;
    await this._write_metadata(collection_name, metadata);
  }

  private async _build_indexes(
    collection_name: string,
    metadata: CollectionMetadata,
    stored: StoredDocument[],
  ): Promise<Map<string, BTreeIndex>> {
    const indexes = new Map<string, BTreeIndex>();
    for (const [index_name, definition] of Object.entries(metadata.indexes)) {
      const entries = new Map<string, IndexReference[]>();
      for (const { key, reference } of this._tree_entries(
        definition.fields,
        stored,
      )) {
        const references = entries.get(key) || [];
        references.push(reference);
        entries.set(key, references);
      }
      indexes.set(
        index_name,
        await BTreeIndex.build(this._index_path(collection_name, index_name), {
          field: index_name,
          generation: metadata.generation,
          unique: definition.unique,
          revision: metadata.revision,
          entries,
        }),
      );
    }
    return indexes;
  }

  private async _validate_unique_values(
    metadata: CollectionMetadata,
    indexes: Map<string, BTreeIndex>,
    documents: MongifyDocument[],
  ): Promise<void> {
    for (const [index_name, definition] of Object.entries(metadata.indexes)) {
      if (!definition.unique) {
        continue;
      }
      const tree = indexes.get(index_name)!;
      const pending = new Set<string>();
      for (const document of documents) {
        const key = this._compound_index_key(definition.fields, document);
        if (key === undefined) continue;
        if ((await tree.search(key)).length > 0 || pending.has(key)) {
          throw new Error(
            `Duplicate value for unique index: ${definition.fields.join(", ")}`,
          );
        }
        pending.add(key);
      }
    }
  }

  private _tree_entries(
    fields: string[],
    stored: StoredDocument[],
  ): Array<{ key: string; reference: IndexReference }> {
    const entries: Array<{ key: string; reference: IndexReference }> = [];
    for (const { document, reference } of stored) {
      const key = this._compound_index_key(fields, document);
      if (key !== undefined) entries.push({ key, reference });
    }
    return entries;
  }

  private async _read_stored_documents(
    collection_name: string,
    metadata: CollectionMetadata,
  ): Promise<StoredDocument[]> {
    const stored: StoredDocument[] = [];
    for (const chunk_name of await this._list_chunks(collection_name, metadata)) {
      stored.push(
        ...(await this._read_stored_chunk(
          collection_name,
          metadata,
          chunk_name,
        )),
      );
    }
    return stored;
  }

  private async _read_stored_chunk(
    collection_name: string,
    metadata: CollectionMetadata,
    chunk_name: string,
  ): Promise<StoredDocument[]> {
    const documents = await this._read_chunk(
      collection_name,
      metadata,
      chunk_name,
    );
    return this._stored_documents_for_chunk(
      chunk_name,
      documents,
      this._prepare_chunk(documents),
    );
  }

  private _stored_documents_for_chunk(
    chunk_name: string,
    documents: MongifyDocument[],
    prepared: PreparedChunk,
  ): StoredDocument[] {
    return documents.map((document, index) => ({
      document,
      reference: {
        chunk: chunk_name,
        id: String(document._id),
        ...prepared.locations[index],
      },
    }));
  }

  private async _read_indexed_document(
    collection_name: string,
    metadata: CollectionMetadata,
    reference: IndexReference,
  ): Promise<MongifyDocument> {
    if (
      !Number.isSafeInteger(reference.offset) ||
      reference.offset! < 0 ||
      !Number.isSafeInteger(reference.length) ||
      reference.length! < 1 ||
      !Array.isArray(reference.dates)
    ) {
      throw new Error("Invalid B+ tree document reference");
    }
    const chunk_path = path.join(
      this._chunks_path(collection_name, metadata.generation),
      reference.chunk,
    );
    const handle = await open(chunk_path, "r");
    try {
      const buffer = Buffer.allocUnsafe(reference.length!);
      const { bytesRead } = await handle.read(
        buffer,
        0,
        reference.length!,
        reference.offset!,
      );
      if (bytesRead !== reference.length) {
        throw new Error("Incomplete B+ tree document reference");
      }
      const document = JSON.parse(buffer.toString("utf8"));
      if (String(document?._id) !== reference.id) {
        throw new Error("Stale B+ tree document reference");
      }
      for (const date of reference.dates) {
        if (
          !Array.isArray(date) ||
          date.length !== 2 ||
          !Array.isArray(date[0]) ||
          !date[0].every((segment) => typeof segment === "string") ||
          typeof date[1] !== "number" ||
          !Number.isFinite(date[1])
        ) {
          throw new Error("Invalid date in B+ tree document reference");
        }
        this._restore_date([document], 0, date[0], date[1], reference.chunk);
      }
      return document;
    } finally {
      await handle.close();
    }
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
    const persisted = JSON.parse(serialized);
    if (
      persisted?.format !== CHUNK_FORMAT ||
      !Array.isArray(persisted.documents) ||
      !Array.isArray(persisted.dates)
    ) {
      throw new Error(`Invalid chunk format: ${chunk_name}`);
    }

    const documents: MongifyDocument[] = persisted.documents;
    for (const entry of persisted.dates) {
      if (
        !Array.isArray(entry) ||
        entry.length !== 3 ||
        !Number.isInteger(entry[0]) ||
        !Array.isArray(entry[1]) ||
        !entry[1].every((segment: unknown) => typeof segment === "string") ||
        typeof entry[2] !== "number" ||
        !Number.isFinite(entry[2]) ||
        entry[0] < 0 ||
        entry[0] >= documents.length
      ) {
        throw new Error(`Invalid date metadata in chunk: ${chunk_name}`);
      }
      this._restore_date(documents, entry[0], entry[1], entry[2], chunk_name);
    }
    return documents;
  }

  private _prepare_chunk(documents: MongifyDocument[]): PreparedChunk {
    const prepared = documents.map((document) =>
      this._serialize_document(document),
    );
    return this._prepare_serialized_chunk(prepared);
  }

  private _prepare_serialized_chunk(
    prepared: PreparedDocument[],
  ): PreparedChunk {
    const dates = prepared.flatMap(({ dates }, document_index) =>
      dates.map(({ path: date_path, value }) => [
        document_index,
        date_path,
        value,
      ]),
    );
    const prefix = `{"format":"${CHUNK_FORMAT}","documents":[`;
    const serialized = `${prefix}${prepared
      .map(({ serialized: document }) => document)
      .join(",")}],"dates":${JSON.stringify(dates)}}`;
    let offset = Buffer.byteLength(prefix);
    const locations = prepared.map((document) => {
      const length = Buffer.byteLength(document.serialized);
      const location = {
        offset,
        length,
        dates: document.dates.map(
          ({ path: date_path, value }) =>
            [[...date_path], value] as [string[], number],
        ),
      };
      offset += length + 1;
      return location;
    });
    return {
      serialized,
      bytes: Buffer.byteLength(serialized),
      dateCount: dates.length,
      locations,
    };
  }

  private _serialize_document(document: MongifyDocument): PreparedDocument {
    const dates: SerializedDate[] = [];
    const paths = new WeakMap<object, string[]>();
    paths.set(document, []);

    const serialized = JSON.stringify(document, function (key, value) {
      const original = key === "" ? document : this[key];
      const parent_path = key === "" ? [] : paths.get(this) || [];
      const current_path = key === "" ? [] : [...parent_path, key];

      if (original instanceof Date) {
        const timestamp = original.getTime();
        if (!Number.isFinite(timestamp)) {
          throw new TypeError("Invalid Date values cannot be stored");
        }
        dates.push({ path: current_path, value: timestamp });
        return timestamp;
      }
      if (original && typeof original === "object") {
        paths.set(original, current_path);
      }
      return value;
    });

    if (serialized === undefined) {
      throw new TypeError("Document cannot be serialized as JSON");
    }
    return { serialized, dates };
  }

  private _document_chunk_bytes(
    prepared: PreparedDocument,
    document_index: number,
    existing_date_count: number,
  ): number {
    let bytes = Buffer.byteLength(prepared.serialized);
    if (document_index > 0) {
      bytes += 1;
    }
    prepared.dates.forEach(({ path: date_path, value }, date_index) => {
      if (existing_date_count + date_index > 0) {
        bytes += 1;
      }
      bytes += Buffer.byteLength(
        JSON.stringify([document_index, date_path, value]),
      );
    });
    return bytes;
  }

  private _restore_date(
    documents: MongifyDocument[],
    document_index: number,
    date_path: string[],
    timestamp: number,
    chunk_name: string,
  ): void {
    if (date_path.length === 0) {
      documents[document_index] = new Date(timestamp) as any;
      return;
    }

    let target: any = documents[document_index];
    for (const segment of date_path.slice(0, -1)) {
      if (target === null || typeof target !== "object" || !(segment in target)) {
        throw new Error(`Invalid date path in chunk: ${chunk_name}`);
      }
      target = target[segment];
    }
    if (target === null || typeof target !== "object") {
      throw new Error(`Invalid date path in chunk: ${chunk_name}`);
    }
    Object.defineProperty(target, date_path.at(-1)!, {
      value: new Date(timestamp),
      enumerable: true,
      configurable: true,
      writable: true,
    });
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
    await JournalTransaction.beforeWrite(file_path);
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
    if (value instanceof Date) {
      const timestamp = value.getTime();
      if (!Number.isFinite(timestamp)) {
        throw new TypeError("Invalid Date values cannot be indexed");
      }
      return `4:date:${this._sortable_number(timestamp)}`;
    }
    if (typeof value === "number") {
      if (!Number.isFinite(value)) {
        throw new TypeError("Non-finite numbers cannot be indexed");
      }
      return `2:number:${this._sortable_number(value)}`;
    }
    if (typeof value === "string") return `3:string:${value}`;
    if (typeof value === "boolean") return `1:boolean:${value ? 1 : 0}`;
    if (value === null) return "0:null";
    return `5:${typeof value}:${JSON.stringify(value)}`;
  }

  private _sortable_number(value: number): string {
    const buffer = Buffer.allocUnsafe(8);
    buffer.writeDoubleBE(Object.is(value, -0) ? 0 : value);
    if ((buffer[0] & 0x80) !== 0) {
      for (let index = 0; index < buffer.length; index += 1) {
        buffer[index] = 0xff - buffer[index];
      }
    } else {
      buffer[0] ^= 0x80;
    }
    return buffer.toString("hex");
  }

  private _compound_index_key(
    fields: string[],
    source: MongifyDocument,
  ): string | undefined {
    const keys: string[] = [];
    for (const field of fields) {
      if (!Object.prototype.hasOwnProperty.call(source, field)) return undefined;
      keys.push(this._index_key(source[field]));
    }
    if (keys.length === 1) return keys[0];
    return keys.map((key) => `${key.length}:${key}`).join("");
  }

  private _find_equality_index(
    metadata: CollectionMetadata,
    query?: MongifyQuery,
  ): string | undefined {
    const equality = getSimpleEqualityQuery(query);
    if (!equality) return undefined;
    return Object.entries(metadata.indexes)
      .filter(([, definition]) =>
        definition.fields.every((field) =>
          Object.prototype.hasOwnProperty.call(equality, field),
        ),
      )
      .sort(
        ([, left], [, right]) => right.fields.length - left.fields.length,
      )[0]?.[0];
  }

  private _find_single_field_index(
    metadata: CollectionMetadata,
    field: string,
  ): string | undefined {
    return Object.entries(metadata.indexes).find(
      ([, definition]) =>
        definition.fields.length === 1 && definition.fields[0] === field,
    )?.[0];
  }

  private _validate_sort(sort: Record<string, 1 | -1>): void {
    if (sort === null || Array.isArray(sort) || typeof sort !== "object") {
      throw new TypeError("Sort must be an object");
    }
    for (const [field, direction] of Object.entries(sort)) {
      this._validate_field(field);
      if (direction !== 1 && direction !== -1) {
        throw new TypeError(`Sort direction for ${field} must be 1 or -1`);
      }
    }
  }

  private _sort_documents(
    documents: MongifyDocument[],
    sort: Record<string, 1 | -1>,
  ): MongifyDocument[] {
    const fields = Object.entries(sort);
    return documents
      .map((document, position) => ({ document, position }))
      .sort((left, right) => {
        for (const [field, direction] of fields) {
          const compared = this._compare_sort_values(
            left.document[field],
            right.document[field],
          );
          if (compared !== 0) return compared * direction;
        }
        return left.position - right.position;
      })
      .map(({ document }) => document);
  }

  private _compare_sort_values(left: any, right: any): number {
    if (this._values_equal(left, right)) return 0;
    const left_rank = this._sort_type_rank(left);
    const right_rank = this._sort_type_rank(right);
    if (left_rank !== right_rank) return left_rank - right_rank;
    const normalized_left = left instanceof Date ? left.getTime() : left;
    const normalized_right = right instanceof Date ? right.getTime() : right;
    if (
      typeof normalized_left === "number" ||
      typeof normalized_left === "string" ||
      typeof normalized_left === "boolean"
    ) {
      return normalized_left < normalized_right ? -1 : 1;
    }
    const serialized_left = JSON.stringify(normalized_left);
    const serialized_right = JSON.stringify(normalized_right);
    return serialized_left < serialized_right ? -1 : 1;
  }

  private _sort_type_rank(value: any): number {
    if (value === undefined) return 0;
    if (value === null) return 1;
    if (typeof value === "number") return 2;
    if (typeof value === "string") return 3;
    if (typeof value === "boolean") return 4;
    if (value instanceof Date) return 5;
    if (Array.isArray(value)) return 6;
    return 7;
  }

  private _values_equal(left: any, right: any): boolean {
    if (left instanceof Date || right instanceof Date) {
      return (
        left instanceof Date &&
        right instanceof Date &&
        left.getTime() === right.getTime()
      );
    }
    return left === right;
  }

  private _validate_field(field: unknown): asserts field is string {
    if (typeof field !== "string" || field.trim() === "" || field.includes("\0")) {
      throw new TypeError("Index field must be a non-empty string");
    }
  }

  private _normalize_index_fields(field: IndexFields): string[] {
    const fields = Array.isArray(field) ? [...field] : [field];
    if (fields.length === 0) {
      throw new TypeError("A compound index requires at least one field");
    }
    fields.forEach((entry) => this._validate_field(entry));
    if (new Set(fields).size !== fields.length) {
      throw new TypeError("A compound index cannot repeat fields");
    }
    return fields;
  }

  private _index_name(fields: string[]): string {
    return fields.length === 1 ? fields[0] : JSON.stringify(fields);
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
      Buffer.from(field).toString("base64url"),
    );
  }

  private _cache_key(collection_name: string, field: string): string {
    return `${this._manifest_path(collection_name)}\0${field}`;
  }

  private _clear_collection_cache(collection_name: string): void {
    BTreeIndex.clearCache(this._indexes_path(collection_name));
    const prefix = `${this._manifest_path(collection_name)}\0`;
    for (const key of index_cache.keys()) {
      if (key.startsWith(prefix)) {
        index_cache.delete(key);
      }
    }
  }
}
