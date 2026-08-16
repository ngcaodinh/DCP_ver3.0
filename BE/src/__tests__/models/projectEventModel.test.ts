import { describe, expect, it } from 'vitest';
import { ProjectEventModel } from '../../models/projectEventModel';

describe('projectEventModel', () => {
  it('dùng collection thường đúng tên với đúng bốn index G4', () => {
    const indexes = ProjectEventModel.schema.indexes() as Array<[
      Record<string, unknown>,
      Record<string, unknown>
    ]>;
    const indexDescriptions = indexes.map(([fields, options]) => ({ fields, options }));

    expect(ProjectEventModel.collection.name).toBe('project_events_timeseries');
    expect(indexes).toHaveLength(4);
    expect(indexDescriptions).toEqual(expect.arrayContaining([
      { fields: { eventId: 1 }, options: expect.objectContaining({ unique: true }) },
      { fields: { eventType: 1, timestamp: -1 }, options: expect.any(Object) },
      { fields: { projectId: 1, timestamp: -1 }, options: expect.any(Object) },
      { fields: { archiveState: 1, timestamp: 1 }, options: expect.any(Object) }
    ]));
  });

  it('không khai báo TTL index và giữ các field retention nullable', () => {
    const indexes = ProjectEventModel.schema.indexes() as Array<[
      Record<string, unknown>,
      Record<string, unknown>
    ]>;
    expect(indexes.some(([, options]) => 'expireAfterSeconds' in options)).toBe(false);
    expect(ProjectEventModel.schema.path('archiveState')).toBeDefined();
    expect(ProjectEventModel.schema.path('archivedAt')).toBeDefined();
    expect(ProjectEventModel.schema.path('archiveLocator')).toBeDefined();
    expect(ProjectEventModel.schema.path('archiveChecksum')).toBeDefined();
  });
});
