      * Customer master record, sample layout used by the codegen test.
      * Covers every value shape the generator has to type: text, zoned
      * decimal, packed decimal, binary, a float and a duplicated name.
       01  CUSTOMER-MASTER.
           05  CUST-ID             PIC 9(5).
           05  CUST-NAME           PIC X(20).
           05  BALANCE             PIC S9(7)V99 COMP-3.
           05  ORDER-COUNT         PIC S9(4) COMP.
           05  RATE                PIC S9(4)V99 COMP-1.
           05  CODES               PIC X(2) OCCURS 3 TIMES.
           05  BILLING.
               10  ADDRESS-LINE    PIC X(10).
           05  SHIPPING.
               10  ADDRESS-LINE    PIC X(10).
