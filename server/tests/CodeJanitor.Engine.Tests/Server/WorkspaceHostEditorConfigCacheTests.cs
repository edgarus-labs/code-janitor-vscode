using CodeJanitor.Engine.Settings;
using CodeJanitor.Server;
using Xunit;

namespace CodeJanitor.Engine.Tests.Server;

[Collection("EditorConfigCache")]
public sealed class WorkspaceHostEditorConfigCacheTests
{
    [Fact]
    public void A_changed_editorconfig_is_dropped_from_the_parse_cache()
    {
        using var tree = new TempTree();
        var editorConfig = tree.Write(".editorconfig", "root = true\n\n[*.cs]\nindent_size = 4\n");
        var file = tree.PathOf("A.cs");
        using var host = new WorkspaceHost(_ => { });
        host.Initialize([tree.Root]);
        EditorConfigOptions.Load(file);
        Assert.True(EditorConfigOptions.IsCached(editorConfig));

        host.FileChanged(editorConfig);

        Assert.False(EditorConfigOptions.IsCached(editorConfig));
    }

    [Fact]
    public void A_changed_source_file_keeps_the_parse_cache()
    {
        using var tree = new TempTree();
        var editorConfig = tree.Write(".editorconfig", "root = true\n\n[*.cs]\nindent_size = 4\n");
        var source = tree.Write("A.cs", "internal class A\n{\n}\n");
        using var host = new WorkspaceHost(_ => { });
        host.Initialize([tree.Root]);
        EditorConfigOptions.Load(source);

        host.FileChanged(source);

        Assert.True(EditorConfigOptions.IsCached(editorConfig));
    }
}
