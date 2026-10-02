namespace Company.App.Views;

using Services;
using System.Text;

internal class OutFileScoped
{
    private Svc svc = new();
    private StringBuilder builder = new();
}
