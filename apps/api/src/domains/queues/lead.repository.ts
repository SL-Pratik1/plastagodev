import type {
  Lead,
  LeadAttachment,
  LeadListItem,
  LeadNote,
  LeadSource,
  LeadStatus,
  PageMeta,
  Zone,
} from '@plastago/shared';
import mongoose from 'mongoose';
import { LeadAttachmentModel, LeadModel, LeadNoteModel } from './lead.model.js';

/**
 * Repository layer — the ONLY file in this domain that touches Mongoose
 * (§6A.3 #5).
 */

export interface ListLeadsQuery {
  page: number;
  pageSize: number;
  sort?: string | undefined;
  q?: string | undefined;
  status?: LeadStatus | undefined;
  source?: LeadSource | undefined;
  /** `null` finds leads OUTSIDE the serviceable zones — a real question. */
  zone?: Zone | null | undefined;
  owner?: string | undefined;
  /** Excludes leads already converted. Defaults on — a converted lead is history. */
  includeConverted?: boolean | undefined;
  agedOverDays?: number | undefined;
}

export interface CreateLeadInput {
  companyName: string;
  contactName: string;
  email: string;
  mobile: string | null;
  source: LeadSource;
  zone: Zone | null;
  suburbs: string;
  typicalVolumeM2: number | null;
  expectedFrequency: string;
  heardAbout: string;
  ownerName: string | null;
}

interface RawLead {
  _id: mongoose.Types.ObjectId;
  companyName: string;
  contactName: string;
  email: string;
  mobile: string | null;
  status: LeadStatus;
  source: LeadSource;
  zone: Zone | null;
  suburbs: string;
  typicalVolumeM2: number | null;
  expectedFrequency: string;
  heardAbout: string;
  ownerName: string | null;
  lastActivityAt: Date;
  convertedAccountId: mongoose.Types.ObjectId | null;
  createdAt: Date;
}

const SORTABLE: Record<string, string> = {
  companyName: 'companyName',
  contactName: 'contactName',
  status: 'status',
  createdAt: 'createdAt',
  lastActivityAt: 'lastActivityAt',
  typicalVolumeM2: 'typicalVolumeM2',
};

function toListItem(row: RawLead): LeadListItem {
  return {
    id: row._id.toHexString(),
    companyName: row.companyName,
    contactName: row.contactName,
    email: row.email,
    mobile: row.mobile,
    status: row.status,
    source: row.source,
    zone: row.zone,
    suburbs: row.suburbs,
    typicalVolumeM2: row.typicalVolumeM2,
    expectedFrequency: row.expectedFrequency,
    ownerName: row.ownerName,
    createdAt: row.createdAt.toISOString(),
    lastActivityAt: row.lastActivityAt.toISOString(),
    convertedAccountId: row.convertedAccountId ? row.convertedAccountId.toHexString() : null,
  };
}

export const leadRepository = {
  async list(query: ListLeadsQuery): Promise<{ data: LeadListItem[]; meta: PageMeta }> {
    const filter: Record<string, unknown> = {};

    if (query.q) filter.$text = { $search: query.q };
    if (query.status) filter.status = query.status;
    if (query.source) filter.source = query.source;
    if (query.owner) filter.ownerName = query.owner;

    /*
     * `zone: null` is a REAL filter value — it finds leads outside the three
     * serviceable zones, which is a list somebody genuinely wants. So the check
     * is for `undefined`, not for falsiness.
     */
    if (query.zone !== undefined) filter.zone = query.zone;

    // A converted lead is history, not work. Hidden unless asked for.
    if (!query.includeConverted) filter.convertedAccountId = null;

    if (query.agedOverDays !== undefined) {
      filter.lastActivityAt = { $lte: new Date(Date.now() - query.agedOverDays * 86_400_000) };
    }

    const sortKey = query.sort?.replace(/^-/, '') ?? '';
    const direction: 1 | -1 = query.sort?.startsWith('-') ? -1 : 1;
    const sortField = SORTABLE[sortKey];

    /*
     * Least recently touched first by default. The pipeline's real question is
     * "who have we not spoken to", and newest-first buries exactly that lead.
     */
    const sort: Record<string, 1 | -1 | { $meta: 'textScore' }> = sortField
      ? { [sortField]: direction }
      : query.q
        ? { score: { $meta: 'textScore' } }
        : { lastActivityAt: 1 };

    const projection = query.q && !sortField ? { score: { $meta: 'textScore' } } : {};

    const [rows, total] = await Promise.all([
      LeadModel.find(filter, projection)
        .sort(sort)
        .skip((query.page - 1) * query.pageSize)
        .limit(query.pageSize)
        .lean<RawLead[]>(),
      LeadModel.countDocuments(filter),
    ]);

    return {
      data: rows.map(toListItem),
      meta: {
        page: query.page,
        pageSize: query.pageSize,
        total,
        totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
      },
    };
  },

  /** One lead with its note thread and attachments. */
  async findById(id: string): Promise<Lead | null> {
    if (!mongoose.isValidObjectId(id)) return null;

    const row = await LeadModel.findById(id).lean<RawLead>();
    if (!row) return null;

    const [notes, attachments] = await Promise.all([
      LeadNoteModel.find({ leadId: row._id }).sort({ at: 1 }).lean(),
      LeadAttachmentModel.find({ leadId: row._id }).sort({ uploadedAt: 1 }).lean(),
    ]);

    return {
      ...toListItem(row),
      heardAbout: row.heardAbout,
      notes: notes.map((note): LeadNote => ({
        id: note._id.toHexString(),
        at: note.at.toISOString(),
        author: note.author,
        body: note.body,
      })),
      attachments: attachments.map((file): LeadAttachment => ({
        id: file._id.toHexString(),
        fileName: file.fileName,
        sizeBytes: file.sizeBytes,
        contentType: file.contentType,
        uploadedAt: file.uploadedAt.toISOString(),
        uploadedBy: file.uploadedBy,
        // Resolved to a short-lived URL by the service; the key never leaves
        // the server.
        url: null,
      })),
    };
  },

  async create(input: CreateLeadInput): Promise<string> {
    const created = await LeadModel.create({
      ...input,
      // Always `new`. See the warning on the model.
      status: 'new',
      lastActivityAt: new Date(),
    });

    return created._id.toHexString();
  },

  /** Leads for the same company, so the office is warned before duplicating one. */
  async findByEmail(email: string): Promise<LeadListItem[]> {
    const rows = await LeadModel.find({
      email: email.trim().toLowerCase(),
      convertedAccountId: null,
    })
      .limit(5)
      .lean<RawLead[]>();

    return rows.map(toListItem);
  },

  /**
   * Moves a lead along the pipeline.
   *
   * ⚠️ `convertedAccountId: null` is in the FILTER. A converted lead is history:
   * re-opening one would leave an account with a lead still claiming to be
   * chasing it.
   */
  async update(
    id: string,
    input: { status: LeadStatus; ownerName: string | null },
  ): Promise<boolean> {
    if (!mongoose.isValidObjectId(id)) return false;

    const result = await LeadModel.updateOne(
      { _id: new mongoose.Types.ObjectId(id), convertedAccountId: null },
      { $set: { ...input, lastActivityAt: new Date() } },
    );

    return result.matchedCount === 1;
  },

  async addNote(input: {
    leadId: string;
    body: string;
    author: string;
    authorId: string | null;
  }): Promise<LeadNote> {
    const created = await LeadNoteModel.create({
      leadId: new mongoose.Types.ObjectId(input.leadId),
      at: new Date(),
      author: input.author,
      authorId: input.authorId ? new mongoose.Types.ObjectId(input.authorId) : null,
      body: input.body,
    });

    // A note IS activity — the pipeline's clock moves when a human does
    // something, and writing a note is the commonest something.
    await LeadModel.updateOne(
      { _id: new mongoose.Types.ObjectId(input.leadId) },
      { $set: { lastActivityAt: new Date() } },
    );

    return {
      id: created._id.toHexString(),
      at: created.at.toISOString(),
      author: created.author,
      body: created.body,
    };
  },

  async addAttachment(input: {
    leadId: string;
    fileName: string;
    sizeBytes: number;
    contentType: string;
    uploadedBy: string;
    storageKey: string;
  }): Promise<{ id: string }> {
    const created = await LeadAttachmentModel.create({
      leadId: new mongoose.Types.ObjectId(input.leadId),
      fileName: input.fileName,
      sizeBytes: input.sizeBytes,
      contentType: input.contentType,
      uploadedAt: new Date(),
      uploadedBy: input.uploadedBy,
      storageKey: input.storageKey,
    });

    await LeadModel.updateOne(
      { _id: new mongoose.Types.ObjectId(input.leadId) },
      { $set: { lastActivityAt: new Date() } },
    );

    return { id: created._id.toHexString() };
  },

  /**
   * Every attachment's storage key for one lead, by attachment id.
   *
   * One query, because the service needs all of them at once to mint download
   * URLs — asking per attachment was a query per row on every read of the
   * detail screen, for data the same screen had already loaded.
   */
  async attachmentKeys(leadId: string): Promise<Map<string, string>> {
    if (!mongoose.isValidObjectId(leadId)) return new Map();

    const rows = await LeadAttachmentModel.find({
      leadId: new mongoose.Types.ObjectId(leadId),
    }).lean<{ _id: mongoose.Types.ObjectId; storageKey: string }[]>();

    return new Map(rows.map((row) => [row._id.toHexString(), row.storageKey]));
  },

  async findAttachment(
    attachmentId: string,
    leadId: string,
  ): Promise<{ id: string; storageKey: string } | null> {
    if (!mongoose.isValidObjectId(attachmentId)) return null;

    const row = await LeadAttachmentModel.findOne({
      _id: new mongoose.Types.ObjectId(attachmentId),
      leadId: new mongoose.Types.ObjectId(leadId),
    }).lean<{ _id: mongoose.Types.ObjectId; storageKey: string }>();

    return row ? { id: row._id.toHexString(), storageKey: row.storageKey } : null;
  },

  async removeAttachment(attachmentId: string, leadId: string): Promise<boolean> {
    if (!mongoose.isValidObjectId(attachmentId)) return false;

    const result = await LeadAttachmentModel.deleteOne({
      _id: new mongoose.Types.ObjectId(attachmentId),
      leadId: new mongoose.Types.ObjectId(leadId),
    });

    return result.deletedCount === 1;
  },

  /**
   * A.4 — marks a lead converted.
   *
   * ⚠️ `convertedAccountId: null` is in the FILTER, so a lead can only be
   * converted ONCE. Two people finishing the wizard at the same time would
   * otherwise create two accounts for one builder, each with its own customer
   * code, and only one of them gets invoiced.
   */
  async markConverted(id: string, accountId: string): Promise<boolean> {
    if (!mongoose.isValidObjectId(id)) return false;

    const result = await LeadModel.updateOne(
      { _id: new mongoose.Types.ObjectId(id), convertedAccountId: null },
      {
        $set: {
          convertedAccountId: new mongoose.Types.ObjectId(accountId),
          convertedAt: new Date(),
          status: 'won',
          lastActivityAt: new Date(),
        },
      },
    );

    return result.matchedCount === 1;
  },

  /** The nav badge: open leads only. */
  async countOpen(): Promise<number> {
    return LeadModel.countDocuments({ convertedAccountId: null, status: { $ne: 'lost' } });
  },

  /**
   * The Won / Conversion cards above the grid.
   *
   * ⚠️ Deliberately NOT derived from `list()`. The grid hides converted leads,
   * so counting its rows made "Won" structurally unable to see a single real
   * win — it could only ever count leads somebody had typed as won without
   * converting. These three counts span every lead, whatever the grid is
   * filtered to.
   *
   * `won` keys off `convertedAccountId` rather than `status`, because the
   * account reference is the fact and the status is only a label. Rows carrying
   * the label with no account behind it are still open work, and are counted
   * there — which is also what makes them visible enough to get fixed.
   */
  async pipelineStats(): Promise<{ open: number; won: number; lost: number }> {
    const [open, won, lost] = await Promise.all([
      LeadModel.countDocuments({ convertedAccountId: null, status: { $ne: 'lost' } }),
      LeadModel.countDocuments({ convertedAccountId: { $ne: null } }),
      LeadModel.countDocuments({ convertedAccountId: null, status: 'lost' }),
    ]);

    return { open, won, lost };
  },
};
