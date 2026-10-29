export type GuicosResourceType<TResource> = new (...args: any[]) => TResource;

export interface IGuicosResourceManager {
    /** Download dependencies without creating or retaining resource instances. */
    preload?<TResource>(path: string, type: GuicosResourceType<TResource>): Promise<void>;
    load<TResource>(path: string, type: GuicosResourceType<TResource>): Promise<TResource>;
}
