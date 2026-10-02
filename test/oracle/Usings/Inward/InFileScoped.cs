using System.Text;
using Company.App.Services;

namespace Company.App.Views;

internal class InFileScoped
{
    private Svc svc = new();
    private StringBuilder builder = new();
}
