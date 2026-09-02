// Each TestApp sets VRTTI_DB and VRTTI_TOKEN as environment variables, which are
// process-wide. Two test classes in parallel would overwrite each other's database path
// and share one file, so the changes and purge tests would see foreign documents.
[assembly: CollectionBehavior(DisableTestParallelization = true)]
