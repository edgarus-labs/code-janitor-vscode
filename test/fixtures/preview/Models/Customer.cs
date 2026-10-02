using System;
using System.Collections.Generic;
using System.Linq;

namespace Shop.Models
{
    class Customer
    {
        string _name;   
        public Customer(string name)
        {
            _name = name;   
        }

        public string Name => _name;
        public List<string> Tags { get; } = new List<string>();


        public bool HasTag(string tag)
        {
            if (Tags == null) return false;
            return Tags.Contains(tag);
        }
    }
}
