      * Variable length record: the table is sized by LINE-COUNT, and TOTAL
      * sits after it, which is what proves the walk moves the tail per record.
       01  ORDER-RECORD.
           05  ORDER-ID    PIC 9(5).
           05  LINE-COUNT  PIC 9(2).
           05  LINES OCCURS 1 TO 3 TIMES DEPENDING ON LINE-COUNT.
               10  ITEM-CODE PIC X(3).
               10  QTY       PIC S9(3) COMP-3.
           05  TOTAL       PIC S9(5)V99 COMP-3.
