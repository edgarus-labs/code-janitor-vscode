namespace Oracle.Shapes
{
    public abstract class Shape
    {
        protected abstract double Area();

        public virtual string Describe() => GetType().Name + ": " + Area();

        protected static double Square(double value) => value * value;
    }

    public class Circle : Shape
    {
        private readonly double radius;

        public Circle(double radius) { this.radius = radius; }

        protected override double Area() => Math.PI * Square(radius);

        public override string Describe() => "circle " + base.Describe();
    }

    public class Rectangle : Shape
    {
        public double Width { get; set; }
        public double Height { get; set; }

        protected override double Area() => Width * Height;
    }

    public sealed class Unit : Rectangle
    {
        public Unit() { Width = 1; Height = 1; }
    }

    internal class InternalBase
    {
        public virtual int Value() => 1;
    }

    internal class InternalDerived : InternalBase
    {
        public override int Value() => 2;
    }
}
