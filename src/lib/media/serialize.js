/** Shared shape for turning a Media document + a freshly-signed access token into API JSON. */
export function serializeMedia(item, token) {
  const tokenParam = token ? `token=${token}` : "";
  const qs = tokenParam ? `?${tokenParam}` : "";
  const previewQs = tokenParam ? `?variant=preview&${tokenParam}` : "?variant=preview";
  return {
    id: item._id.toString(),
    dayKey: item.dayKey,
    type: item.type,
    processingStatus: item.processingStatus,
    processingError: item.processingError,
    width: item.width,
    height: item.height,
    duration: item.duration,
    size: item.size,
    captureDate: item.captureDate,
    captureDateSource: item.captureDateSource,
    uploadDate: item.uploadDate,
    title: item.title,
    description: item.description,
    caption: item.caption,
    location: item.location,
    camera: item.camera,
    favorite: item.favorite,
    tags: item.tags,
    people: item.people,
    uploaderId: item.uploaderId?.toString?.() || item.uploaderId,
    thumbnailUrl: item.thumbnailKey ? `/api/media/${item._id}/thumbnail${qs}` : null,
    previewUrl: item.previewKey ? `/api/media/${item._id}/file${previewQs}` : null,
    fileUrl: `/api/media/${item._id}/file${qs}`,
    createdAt: item.createdAt,
  };
}
